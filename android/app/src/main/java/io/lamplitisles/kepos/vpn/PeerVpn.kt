package io.lamplitisles.kepos.vpn

import android.content.Context
import android.content.Intent
import android.net.VpnService
import java.io.File
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

/** The system tunnel's state, which is separate from receiver connectivity. */
enum class Phase { Idle, Pairing, Connecting, Connected, Disconnecting }

/** Fixed reasons the UI may present. Text belongs to the UI layer. */
enum class PeerVpnError {
  LocalState,
  IdentityInUse,
  UnusableInvitation,
  ReceiverUnavailable,
  ReceiverCapacity,
  ReceiverRouteConflict,
  LocalAddressConflict,
  RouteInspectionUnavailable,
  PairingOutcomeUnknown,
  PairingConflictUnknown,
  ReceiverExcludedAddress,
  VpnPermissionRequired,
  Unpaired,
  Busy,
  ProviderUnavailable,
}

data class VpnPeer(val publicKey: String, val label: String, val connected: Boolean)

data class PeerVpnState(
  /** 64 lowercase hex characters once the identity has been read. */
  val publicKey: String? = null,
  val paired: Boolean = false,
  val phase: Phase = Phase.Idle,
  /** False until the system grants the VPN permission to this app. */
  val consentGranted: Boolean = false,
  /** Last actionable failure; [PeerVpnController.dismissFailure] clears it. */
  val failure: PeerVpnError? = null,
  /** Null means peer status is unavailable, not that no peer is connected. */
  val peers: List<VpnPeer>? = null,
)

internal fun TunnelFailure.toError(pairing: Boolean): PeerVpnError =
  when (this) {
    TunnelFailure.Configuration, TunnelFailure.LocalState, TunnelFailure.Identity -> PeerVpnError.LocalState
    TunnelFailure.WorkletUnavailable, TunnelFailure.TunnelDevice -> PeerVpnError.ProviderUnavailable
    TunnelFailure.Bridge, TunnelFailure.Timeout ->
      if (pairing) PeerVpnError.PairingOutcomeUnknown else PeerVpnError.ProviderUnavailable
    TunnelFailure.Invitation -> PeerVpnError.UnusableInvitation
    // Nothing left this device, so the failure is local and the invitation is
    // still usable; it must not look like an unknown pairing.
    TunnelFailure.PairingNotSubmitted -> PeerVpnError.ProviderUnavailable
    TunnelFailure.ReceiverUnavailable -> PeerVpnError.ReceiverUnavailable
    TunnelFailure.PairingUnknown -> PeerVpnError.PairingOutcomeUnknown
    TunnelFailure.Permission -> PeerVpnError.VpnPermissionRequired
    TunnelFailure.IdentityInUse -> PeerVpnError.IdentityInUse
    TunnelFailure.Capacity, TunnelFailure.Pool -> PeerVpnError.ReceiverCapacity
    TunnelFailure.ReceiverRouteConflict -> PeerVpnError.ReceiverRouteConflict
    TunnelFailure.LocalAddressConflict ->
      if (pairing) PeerVpnError.PairingConflictUnknown else PeerVpnError.LocalAddressConflict
    TunnelFailure.RouteInspectionUnavailable ->
      if (pairing) PeerVpnError.PairingOutcomeUnknown else PeerVpnError.RouteInspectionUnavailable
    TunnelFailure.PairingConflictUnknown -> PeerVpnError.PairingConflictUnknown
    TunnelFailure.ExcludedAddress -> PeerVpnError.ReceiverExcludedAddress
    TunnelFailure.RouteInspectionBeforePair -> PeerVpnError.RouteInspectionUnavailable
  }

/** How one pairing or connection attempt ended. */
internal sealed interface OperationOutcome {
  /** The receiver admission succeeded, or the tunnel is running. */
  data object Success : OperationOutcome

  /** The operation stopped before it had an outcome; no failure is reported. */
  data object Cancelled : OperationOutcome

  data class Failed(val error: PeerVpnError) : OperationOutcome
}

/**
 * A stop request may only reach the attempt it was issued for, so a late stop
 * for an abandoned attempt cannot close a newer tunnel.
 */
internal fun stopTargetsAttempt(requestedEpoch: Long?, activeEpoch: Long?): Boolean =
  requestedEpoch == null || activeEpoch == null || requestedEpoch == activeEpoch

/**
 * One pairing or connection attempt. The service completes it, the controller
 * waits for it, and only the current operation may change the published state.
 */
internal class Operation internal constructor(val epoch: Long) {
  internal val result = CompletableDeferred<OperationOutcome>()

  /** The invitation has been queued to the worklet and may reach the receiver. */
  @Volatile internal var invitationSubmitted = false
}

/**
 * The state shared by the activity and the service in one process. Process
 * death loses it, which is correct: no tunnel outlives the process either.
 *
 * Every mutation that belongs to an operation is checked against the current
 * one, so a late callback from an abandoned attempt cannot overwrite a newer
 * attempt's state.
 */
internal object PeerVpnRuntime {
  private val lock = Any()
  private var generation = 0L
  private var current: Operation? = null

  val state = MutableStateFlow(PeerVpnState())

  fun update(transform: (PeerVpnState) -> PeerVpnState) = state.update(transform)

  fun begin(phase: Phase): Operation =
    synchronized(lock) {
      generation += 1
      val operation = Operation(generation)
      current = operation
      state.update { it.copy(phase = phase, failure = null, peers = null) }
      operation
    }

  /** The service-side handle for an operation, or null when it is stale. */
  fun adopt(epoch: Long): Operation? = synchronized(lock) { current?.takeIf { it.epoch == epoch } }

  /** Epoch of the attempt in progress, for an operation-scoped stop request. */
  fun currentEpoch(): Long? = synchronized(lock) { current?.epoch }

  /** Public identity, which is not scoped to an operation. */
  fun identity(managed: ManagedState) = state.update { it.copy(publicKey = managed.publicKey, paired = managed.paired) }

  fun identity(operation: Operation, managed: ManagedState) {
    synchronized(lock) {
      if (current !== operation) return
      state.update { it.copy(publicKey = managed.publicKey, paired = managed.paired) }
    }
  }

  /** Records that this attempt's invitation may have reached the receiver. */
  fun invitationSubmitted(operation: Operation) {
    synchronized(lock) {
      if (current !== operation) return
      operation.invitationSubmitted = true
    }
  }

  /** The tunnel is running; the waiting controller is released here. */
  fun connected(operation: Operation) {
    synchronized(lock) {
      if (current !== operation) return
      state.update { it.copy(phase = Phase.Connected) }
      operation.result.complete(OperationOutcome.Success)
    }
  }

  /**
   * Peer status for this attempt only. The worklet reports its configured peers
   * while the attempt is still connecting, so both phases keep the list.
   */
  fun publishPeers(operation: Operation, peers: List<PeerStatus>) {
    synchronized(lock) {
      if (current !== operation) return
      state.update { published ->
        if (published.phase != Phase.Connecting && published.phase != Phase.Connected) {
          published
        } else {
          published.copy(peers = peers.map { peer -> VpnPeer(peer.publicKey, peer.label, peer.connected) })
        }
      }
    }
  }

  /** Ends the operation. Later callbacks for it are ignored from here on. */
  fun finished(operation: Operation, outcome: OperationOutcome) {
    synchronized(lock) {
      if (current !== operation) return
      current = null
      val failure = (outcome as? OperationOutcome.Failed)?.error
      state.update { it.copy(phase = Phase.Idle, peers = null, failure = failure) }
      operation.result.complete(outcome)
    }
  }

  /** Gives up on an operation without waiting for the service. */
  fun abandon(operation: Operation, failure: PeerVpnError?) {
    synchronized(lock) {
      if (current !== operation) return
      current = null
      state.update { it.copy(phase = Phase.Idle, peers = null, failure = failure) }
      operation.result.complete(OperationOutcome.Cancelled)
    }
  }

  /** Clears published state when no operation is running. */
  fun idle() {
    synchronized(lock) {
      if (current != null) return
      state.update { it.copy(phase = Phase.Idle, peers = null) }
    }
  }
}

object PeerVpn {
  @Volatile private var controller: PeerVpnController? = null

  /** One process-wide controller; the activity passes any application context. */
  fun get(context: Context): PeerVpnController =
    controller ?: synchronized(this) {
      controller ?: PeerVpnController(context.applicationContext).also { controller = it }
    }
}

/**
 * Android side of a pairing or connection: the system consent API, the
 * identity store and the service intents. Tests substitute a fake.
 */
internal interface VpnBoundary {
  fun consentIntent(): Intent?

  fun consentGranted(): Boolean

  fun prepareIdentity(): ManagedState

  /** Durable removal of the pending marker; false means it is still there. */
  fun clearPairingPending(): Boolean

  fun startPair(epoch: Long, invitation: String): Boolean

  fun startConnect(epoch: Long): Boolean

  /** Requests a stop for one attempt, or for whatever runs when null. */
  fun stop(epoch: Long?): Boolean
}

internal class AndroidVpnBoundary(private val context: Context) : VpnBoundary {
  private val peerState = PeerState(keposRoot(context), AndroidDirectorySync)

  override fun consentIntent(): Intent? =
    try {
      VpnService.prepare(context)
    } catch (_: Exception) {
      null
    }

  override fun consentGranted(): Boolean =
    try {
      VpnService.prepare(context) == null
    } catch (_: Exception) {
      false
    }

  override fun prepareIdentity(): ManagedState = peerState.prepare()

  override fun clearPairingPending(): Boolean = peerState.clearPairingPending()

  override fun startPair(epoch: Long, invitation: String) = KeposVpnService.pair(context, invitation, epoch)

  override fun startConnect(epoch: Long) = KeposVpnService.connect(context, epoch)

  override fun stop(epoch: Long?) = KeposVpnService.stop(context, epoch)
}

class PeerVpnController internal constructor(
  private val boundary: VpnBoundary,
  private val timeouts: Timeouts = Timeouts(),
) {
  internal constructor(context: Context) : this(AndroidVpnBoundary(context.applicationContext))

  internal data class Timeouts(val pairMillis: Long = 60_000L, val connectMillis: Long = 40_000L)

  val state: StateFlow<PeerVpnState> = PeerVpnRuntime.state

  /** The system consent screen, or null when Kepos already holds the permission. */
  fun consentIntent(): Intent? = boundary.consentIntent()

  /** Reads or creates the fixed identity. Call on start and after consent. */
  suspend fun prepareIdentity(): PeerVpnError? = withContext(Dispatchers.IO) {
    try {
      val managed = boundary.prepareIdentity()
      PeerVpnRuntime.identity(managed)
      refreshConsent()
      // An earlier invitation may have been admitted. Neither a newer attempt
      // nor an older configuration can settle that; only an acknowledgement.
      if (managed.pairingPending) report(PeerVpnError.PairingOutcomeUnknown) else null
    } catch (error: VpnFailure) {
      report(error.reason.toError(pairing = false))
    }
  }

  /**
   * The operator checked the receiver and confirmed the earlier attempt. The
   * marker is removed durably first; when that fails the unknown state stays
   * and the caller gets an actionable error instead of a cleared warning.
   */
  suspend fun acknowledgeUnknownPairing(): PeerVpnError? = withContext(Dispatchers.IO) {
    val cleared =
      try {
        boundary.clearPairingPending()
      } catch (error: VpnFailure) {
        return@withContext error.reason.toError(pairing = true)
      }
    if (!cleared) return@withContext PeerVpnError.LocalState
    PeerVpnRuntime.update { it.copy(failure = null) }
    null
  }

  fun refreshConsent() = PeerVpnRuntime.update { it.copy(consentGranted = boundary.consentGranted()) }

  /**
   * Authenticated admission. Pairing opens no TUN, so it needs no system VPN
   * permission, only an idle controller. An unconfirmed outcome is reported as
   * [PeerVpnError.PairingOutcomeUnknown] and must not be retried automatically.
   */
  suspend fun pair(invitation: String): PeerVpnError? {
    if (PeerVpnRuntime.state.value.phase != Phase.Idle) return PeerVpnError.Busy
    val operation = PeerVpnRuntime.begin(Phase.Pairing)
    if (!boundary.startPair(operation.epoch, invitation)) {
      PeerVpnRuntime.abandon(operation, PeerVpnError.ProviderUnavailable)
      return PeerVpnError.ProviderUnavailable
    }
    return await(operation, timeouts.pairMillis, PeerVpnError.PairingOutcomeUnknown, pairing = true)
  }

  /** Connects with the stored configuration. */
  suspend fun connect(): PeerVpnError? {
    if (PeerVpnRuntime.state.value.phase != Phase.Idle) return PeerVpnError.Busy
    if (PeerVpnRuntime.state.value.paired != true) return report(PeerVpnError.Unpaired)
    if (!PeerVpnRuntime.state.value.consentGranted) return report(PeerVpnError.VpnPermissionRequired)
    val operation = PeerVpnRuntime.begin(Phase.Connecting)
    if (!boundary.startConnect(operation.epoch)) {
      PeerVpnRuntime.abandon(operation, PeerVpnError.ProviderUnavailable)
      return PeerVpnError.ProviderUnavailable
    }
    return await(operation, timeouts.connectMillis, PeerVpnError.ProviderUnavailable, pairing = false)
  }

  /** Requests an orderly disconnect; the state moves through [Phase.Disconnecting]. */
  fun disconnect() {
    val current = PeerVpnRuntime.state.value
    if (current.phase == Phase.Idle) return
    PeerVpnRuntime.update { it.copy(phase = Phase.Disconnecting) }
    if (!boundary.stop(PeerVpnRuntime.currentEpoch())) {
      // The tunnel was not asked to stop, so report it as still connected.
      PeerVpnRuntime.update { it.copy(phase = current.phase, failure = PeerVpnError.ProviderUnavailable) }
    }
  }

  fun dismissFailure() = PeerVpnRuntime.update { it.copy(failure = null) }

  private suspend fun await(
    operation: Operation,
    timeoutMillis: Long,
    timeoutFailure: PeerVpnError,
    pairing: Boolean,
  ): PeerVpnError? {
    val outcome =
      try {
        withTimeoutOrNull(timeoutMillis) { operation.result.await() }
      } catch (cancelled: CancellationException) {
        // The service runs in its own scope, so an abandoned attempt could keep
        // a tunnel running. Ask it to stop this attempt only; a stop for it can
        // never reach a newer one.
        // A pairing that may already have reached the receiver keeps an unknown
        // outcome instead of disappearing.
        val failure = if (pairing && operation.invitationSubmitted) PeerVpnError.PairingOutcomeUnknown else null
        stopAttempt(operation, failure)
        throw cancelled
      }
    return when (outcome) {
      null ->
        // The service may already have reached the receiver; stop it and report
        // the attempt as unknown instead of leaving the activity waiting. If the
        // stop cannot be dispatched the attempt stays visible and closable.
        if (stopAttempt(operation, timeoutFailure)) timeoutFailure else PeerVpnError.ProviderUnavailable
      OperationOutcome.Success, OperationOutcome.Cancelled -> null
      is OperationOutcome.Failed -> outcome.error
    }
  }

  /**
   * Ends an attempt that may still be running. A stop that cannot be dispatched
   * leaves the attempt current, so the tunnel stays closable through
   * [disconnect] and its own outcome still reaches the state.
   */
  private fun stopAttempt(operation: Operation, failureWhenStopped: PeerVpnError?): Boolean {
    if (boundary.stop(operation.epoch)) {
      PeerVpnRuntime.abandon(operation, failureWhenStopped)
      return true
    }
    PeerVpnRuntime.update { it.copy(failure = PeerVpnError.ProviderUnavailable) }
    return false
  }

  private fun report(failure: PeerVpnError): PeerVpnError {
    PeerVpnRuntime.update { it.copy(failure = failure) }
    return failure
  }
}

/** App-private directory owned by the service and the controller together. */
internal fun keposRoot(context: Context): File = File(context.filesDir, "kepos")
