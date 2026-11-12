package io.lamplitisles.kepos.vpn

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** One running Bare worklet. An implementation starts exactly one per instance. */
internal interface WorkletSession : AutoCloseable {
  fun start()

  suspend fun write(frame: ByteArray)

  /** One chunk written by the worklet, or null once it closed its side. */
  suspend fun receive(): ByteArray?

  /** Ends the host side of the IPC so the worklet can exit on its own. */
  fun endInput()

  /** Exit code, or null when it did not exit within the timeout. */
  suspend fun awaitExit(timeoutMillis: Long): Int?

  fun terminate()
}

internal class TunRequest(val address: String, val peerAddresses: List<String>)

/** Opens the system TUN device; a failure must stop the session. */
internal fun interface TunFactory {
  fun open(request: TunRequest): TunSink
}

internal interface TunSink : AutoCloseable {
  /** Next IPv4 packet, or null once the device is closed. */
  suspend fun read(): ByteArray?

  fun write(packet: ByteArray): Boolean
}

/**
 * Publishes the packet gate before the ready frame can be written. The writer
 * consumes the outbound queue concurrently on its own coroutine, so setting the
 * gate afterwards would let the engine answer with a packet the host would then
 * reject. A send that fails propagates and ends the attempt, so the gate is
 * never left open for a frame that was not queued.
 */
internal fun sendReadyFrame(openGate: () -> Unit, send: () -> Unit) {
  openGate()
  send()
}

internal data class PeerStatus(val publicKey: String, val label: String, val connected: Boolean)

/**
 * One peer VPN operation and its teardown.
 *
 * The identity lock is held for the whole operation and released only when the
 * worklet has exited. A session is used once: the service creates a new one per
 * pairing or connection attempt.
 */
internal class TunnelSession(
  private val peerState: PeerState,
  private val workletFactory: () -> WorkletSession,
  private val tunFactory: TunFactory,
  private val localIpv4: LocalIpv4Source,
  private val onPeers: (List<PeerStatus>) -> Unit,
  private val onPairSubmitted: () -> Unit = {},
  private val timeouts: Timeouts = Timeouts(),
) {
  internal data class Timeouts(
    val startupMillis: Long = 30_000,
    val stopMillis: Long = 3_000,
    val exitMillis: Long = 3_000,
  )

  private sealed interface Event {
    data class Message(val value: WorkletMessage) : Event

    data class Failed(val reason: TunnelFailure) : Event

    data object Stop : Event
  }

  private object StopRequested : Exception()

  private val events = Channel<Event>(Channel.UNLIMITED)
  private val outbound = Channel<ByteArray>(OUTBOUND_LIMIT)
  private val decoder = FrameDecoder()
  private val peers = mutableListOf<PeerStatus>()

  private var lock: IdentityLock? = null
  private var worklet: WorkletSession? = null
  private var tun: TunSink? = null
  private var config: ManagedConfig? = null
  private var seed: ByteArray? = null
  private var publicKey: String? = null
  private var jobs: List<Job> = emptyList()
  private var settingsApplied = false
  /** The engine may start once the ready frame is queued, so packets are legal. */
  @Volatile private var ready = false
  @Volatile private var running = false
  private var stopping = false
  private var closed = false
  private var released = false
  private var workletExited = true

  /** Reads or creates the fixed identity; never while a tunnel is running. */
  fun prepareIdentity(): ManagedState = peerState.prepare()

  /**
   * Authenticated admission. Returns only after the configuration is durable;
   * an unconfirmed outcome is reported as unknown, never retried here.
   */
  suspend fun pair(invitation: String): ManagedState = coroutineScope {
    val parsed = Invitation.parse(invitation) ?: fail(TunnelFailure.Invitation)
    try {
      setUp()
      // An unconfirmed earlier invitation is checked by the operator first; a
      // new attempt never replaces its marker.
      if (peerState.pairingPending(holdingLock = true)) fail(TunnelFailure.PairingUnknown)
      val current = config
      if (current != null && current.receiverKey != parsed.receiverKey) fail(TunnelFailure.Configuration)
      // Fail before sending a single-use invitation when this device cannot
      // read its own interface addresses at all.
      if (localIpv4.addresses() == null) fail(TunnelFailure.RouteInspectionBeforePair)
      startWorklet()
      launchLoops(this)
      // The marker is durable before the frame can enter the shared outbound
      // queue, so a crash from here on restores the unknown outcome.
      peerState.markPairingPending(holdingLock = true)
      // Mark before the frame can enter the shared outbound queue. The writer
      // consumes that queue concurrently, so marking afterwards could report an
      // already written invitation as unsent.
      onPairSubmitted()
      try {
        sendPair(WorkletCodec.pair(invitation, seedHex()))
      } catch (error: VpnFailure) {
        // Nothing entered the queue, so no receiver can have admitted this. A
        // clear that cannot be proven durable is not fatal here: the leftover
        // marker only makes a later warning conservative, and no unconfirmed
        // attempt can be retried while it is present.
        peerState.clearPairingPending(holdingLock = true)
        throw error
      }
      val message = awaitPairResult(timeouts.startupMillis)
      if (message.type == "pair-error") {
        val reason = pairFailure(message.reason)
        // A definite answer proves the receiver did not admit this device; an
        // unknown reason keeps the marker until it is acknowledged. A clear that
        // cannot be proven durable keeps it too: the receiver's answer stays the
        // reported reason, and the surviving marker blocks an unchecked retry.
        if (reason != TunnelFailure.PairingUnknown) peerState.clearPairingPending(holdingLock = true)
        fail(reason)
      }
      val paired = pairedConfig(message)
      checkLocalConflict(paired.address, listOf(paired.receiverAddress), afterPairing = true)
      val key = publicKey ?: fail(TunnelFailure.Identity)
      val committed =
        try {
          peerState.commitPair(paired, key)
        } catch (_: VpnFailure) {
          fail(TunnelFailure.PairingUnknown)
        }
      // The configuration is durable; a marker that cannot be removed is
      // reported instead of being treated as proof of this attempt.
      if (!peerState.clearPairingPending(holdingLock = true)) fail(TunnelFailure.LocalState)
      committed
    } finally {
      close()
    }
  }

  /**
   * Runs the tunnel until [stop] is requested, the system revokes it or the
   * worklet fails. [onRunning] fires once the receiver connection exists.
   */
  suspend fun connect(onRunning: () -> Unit): Unit = coroutineScope {
    try {
      setUp()
      val current = config ?: fail(TunnelFailure.Configuration)
      startWorklet()
      launchLoops(this)
      send(WorkletCodec.start(current.tunnelConfig, seedHex()))
      val settings = awaitMessage(timeouts.startupMillis, "settings")
      applySettings(settings)
      sendReadyFrame(openGate = { ready = true }, send = { send(WorkletCodec.ready()) })
      awaitRunning(timeouts.startupMillis)
      onRunning()
      jobs = jobs + launch { pumpLoop() }
      awaitStop()
    } catch (_: StopRequested) {
      // A stop requested before the tunnel was running is not an error.
    } finally {
      close()
    }
  }

  /** Requests an orderly stop. */
  suspend fun stop() {
    events.send(Event.Stop)
  }

  /**
   * Releases the worklet, TUN and identity lock. Returns false when the worklet
   * never exited: another runtime must not then reuse the identity, so the
   * caller terminates its process instead.
   */
  suspend fun close(): Boolean = withContext(NonCancellable) { release() }

  private suspend fun release(): Boolean {
    if (closed) return released
    closed = true
    stopping = true
    running = false
    val session = worklet
    if (session != null) {
      trySendControl(WorkletCodec.stop())
      awaitStopped(timeouts.stopMillis)
      runCatching { session.endInput() }
      workletExited = session.awaitExit(timeouts.exitMillis) != null
      if (!workletExited) {
        runCatching { session.terminate() }
        workletExited = session.awaitExit(timeouts.exitMillis) != null
      }
      runCatching { session.close() }
    }
    jobs.forEach { it.cancel() }
    outbound.close()
    events.close()
    // Close the TUN before joining: a blocked read is only released by the
    // descriptor closing, not by coroutine cancellation.
    val device = tun
    tun = null
    runCatching { device?.close() }
    jobs.forEach { job -> withTimeoutOrNull(timeouts.stopMillis) { runCatching { job.join() } } }
    jobs = emptyList()
    runCatching { decoder.finish() }
    seed?.fill(0)
    seed = null
    peers.clear()
    val held = lock
    lock = null
    released = worklet == null || workletExited
    if (released) runCatching { held?.close() }
    return released
  }

  private fun setUp() {
    lock = peerState.acquireLock()
    config = peerState.store.read()
    seed =
      try {
        peerState.identity.readSeed()
      } catch (_: IdentityException) {
        fail(TunnelFailure.Identity)
      }
    publicKey = PublicKey.deriveHex(seed!!)
  }

  private fun startWorklet() {
    val session =
      try {
        workletFactory()
      } catch (_: Throwable) {
        fail(TunnelFailure.WorkletUnavailable)
      }
    worklet = session
    workletExited = false
    try {
      session.start()
    } catch (_: Throwable) {
      fail(TunnelFailure.WorkletUnavailable)
    }
  }

  private fun launchLoops(scope: CoroutineScope) {
    jobs =
      listOf(
        scope.launch { readLoop() },
        scope.launch { writeLoop() },
      )
  }

  private suspend fun readLoop() {
    val session = worklet ?: return
    while (true) {
      val chunk =
        try {
          session.receive()
        } catch (_: Throwable) {
          events.trySend(Event.Failed(TunnelFailure.Bridge))
          return
        }
      if (chunk == null) {
        if (!stopping) events.trySend(Event.Failed(TunnelFailure.Bridge))
        return
      }
      try {
        decoder.append(chunk) { kind, payload -> deliver(kind, payload) }
      } catch (_: IpcFramingException) {
        events.trySend(Event.Failed(TunnelFailure.Bridge))
        return
      }
    }
  }

  /**
   * Reads one packet at a time from the TUN and hands it to the worklet. The
   * next read starts only after the previous packet was accepted, so at most
   * [OUTBOUND_LIMIT] frames exist in either direction.
   */
  private suspend fun pumpLoop() {
    while (running) {
      val device = tun ?: return
      val packet = device.read()
      if (packet == null) {
        // The descriptor closes on shutdown, but it can also fail under a
        // running tunnel: a silent return would leave the session reported as
        // connected while no packet can move.
        if (running) events.trySend(Event.Failed(TunnelFailure.TunnelDevice))
        return
      }
      if (!running) return
      trySendPacket(packet)
    }
  }

  private suspend fun writeLoop() {
    val session = worklet ?: return
    for (frame in outbound) {
      try {
        session.write(frame)
      } catch (_: Throwable) {
        events.trySend(Event.Failed(TunnelFailure.Bridge))
        return
      }
    }
  }

  private fun deliver(kind: Int, payload: ByteArray) {
    if (kind == IpcFrames.CONTROL) {
      val message =
        try {
          WorkletCodec.decode(payload)
        } catch (_: Exception) {
          events.trySend(Event.Failed(TunnelFailure.Bridge))
          return
        }
      // The worklet can report a packet immediately after the running message,
      // possibly inside the same IPC chunk, so packets are legal from here.
      if (message.type == "running") running = true
      events.trySend(Event.Message(message))
      return
    }
    if (!ready) {
      events.trySend(Event.Failed(TunnelFailure.Bridge))
      return
    }
    if (payload.size < 20 || payload.size > VPN_MTU) {
      events.trySend(Event.Failed(TunnelFailure.Bridge))
      return
    }
    val device = tun ?: return
    if (!device.write(payload)) events.trySend(Event.Failed(TunnelFailure.Bridge))
  }

  /** Control frames must be delivered; congestion fails the session. */
  private fun send(payload: ByteArray) {
    if (outbound.trySend(IpcFrames.encode(IpcFrames.CONTROL, payload)).isFailure) fail(TunnelFailure.Bridge)
  }

  /**
   * The pair frame is the only carrier of the invitation. A queue that refuses
   * it proves nothing was sent, which differs from an interrupted attempt.
   */
  private fun sendPair(payload: ByteArray) {
    if (outbound.trySend(IpcFrames.encode(IpcFrames.CONTROL, payload)).isFailure) {
      fail(TunnelFailure.PairingNotSubmitted)
    }
  }

  private fun trySendControl(payload: ByteArray) {
    outbound.trySend(IpcFrames.encode(IpcFrames.CONTROL, payload))
  }

  /** Packets beyond the in-flight bound are dropped, never queued. */
  private fun trySendPacket(packet: ByteArray) {
    if (packet.size < 20 || packet.size > VPN_MTU) return
    outbound.trySend(IpcFrames.encode(IpcFrames.PACKET, packet))
  }

  private suspend fun nextEvent(timeoutMillis: Long?): Event {
    if (timeoutMillis == null) return events.receiveCatching().getOrNull() ?: Event.Failed(TunnelFailure.Bridge)
    return withTimeoutOrNull(timeoutMillis) { events.receiveCatching().getOrNull() ?: Event.Failed(TunnelFailure.Bridge) }
      ?: Event.Failed(TunnelFailure.Timeout)
  }

  private suspend fun awaitMessage(timeoutMillis: Long, expected: String): WorkletMessage {
    while (true) {
      when (val event = nextEvent(timeoutMillis)) {
        is Event.Failed -> fail(event.reason)
        Event.Stop -> throw StopRequested
        is Event.Message ->
          if (event.value.type == expected) return event.value else fail(TunnelFailure.Bridge)
      }
    }
  }

  /**
   * The engine starts its dial peers without awaiting them and reports their
   * status before its start call returns, so a peer message can precede the
   * running message.
   */
  private suspend fun awaitRunning(timeoutMillis: Long) {
    while (true) {
      when (val event = nextEvent(timeoutMillis)) {
        is Event.Failed -> fail(event.reason)
        Event.Stop -> throw StopRequested
        is Event.Message ->
          when (event.value.type) {
            "running" -> return
            "peer" -> applyPeer(event.value)
            else -> fail(TunnelFailure.Bridge)
          }
      }
    }
  }

  private suspend fun awaitPairResult(timeoutMillis: Long): WorkletMessage {
    while (true) {
      when (val event = nextEvent(timeoutMillis)) {
        is Event.Failed -> fail(event.reason)
        Event.Stop -> fail(TunnelFailure.PairingUnknown)
        is Event.Message ->
          when (event.value.type) {
            "paired", "pair-error" -> return event.value
            else -> fail(TunnelFailure.Bridge)
          }
      }
    }
  }

  private suspend fun awaitStop() {
    while (true) {
      when (val event = nextEvent(null)) {
        is Event.Failed -> fail(event.reason)
        Event.Stop -> return
        is Event.Message ->
          when (event.value.type) {
            "peer" -> applyPeer(event.value)
            else -> fail(TunnelFailure.Bridge)
          }
      }
    }
  }

  private suspend fun awaitStopped(timeoutMillis: Long) {
    withTimeoutOrNull(timeoutMillis) {
      while (true) {
        val event = events.receiveCatching().getOrNull() ?: return@withTimeoutOrNull
        val message = (event as? Event.Message)?.value ?: continue
        if (message.type == "stopped") return@withTimeoutOrNull
      }
    }
  }

  private fun applySettings(message: WorkletMessage) {
    if (settingsApplied) fail(TunnelFailure.Bridge)
    val address = message.address ?: fail(TunnelFailure.Bridge)
    if (!ManagedConfig.validAddress(address)) fail(TunnelFailure.Bridge)
    val reported = message.peers ?: fail(TunnelFailure.Bridge)
    if (reported.size > 16) fail(TunnelFailure.Bridge)
    val addresses = mutableListOf<String>()
    val keys = mutableSetOf<String>()
    for (peer in reported) {
      if (!ManagedConfig.validAddress(peer.address) || peer.address == address) fail(TunnelFailure.Bridge)
      if (addresses.contains(peer.address)) fail(TunnelFailure.Bridge)
      if (!Hex.isPublicKey(peer.publicKey) || !keys.add(peer.publicKey)) fail(TunnelFailure.Bridge)
      if (peer.connected) fail(TunnelFailure.Bridge)
      if (peer.label.isEmpty() || peer.label.length > 128) fail(TunnelFailure.Bridge)
      if (peer.label.any { it.code < 32 || it.code == 127 }) fail(TunnelFailure.Bridge)
      addresses += peer.address
    }
    // The worklet derives the public key from the seed it was given; a mismatch
    // means the two implementations disagree and must not carry packets.
    val expected = publicKey
    if (expected != null && message.publicKey != expected) fail(TunnelFailure.Bridge)
    checkLocalConflict(address, addresses, afterPairing = false)
    settingsApplied = true
    tun = tunFactory.open(TunRequest(address, addresses))
    peers.clear()
    peers += reported.map { PeerStatus(it.publicKey, it.label, false) }
    onPeers(peers.toList())
  }

  private fun applyPeer(message: WorkletMessage) {
    if (!settingsApplied) fail(TunnelFailure.Bridge)
    val key = message.publicKey ?: fail(TunnelFailure.Bridge)
    val connected = message.connected ?: fail(TunnelFailure.Bridge)
    val index = peers.indexOfFirst { it.publicKey == key }
    if (index < 0) fail(TunnelFailure.Bridge)
    peers[index] = peers[index].copy(connected = connected)
    onPeers(peers.toList())
  }

  private fun checkLocalConflict(address: String, remote: List<String>, afterPairing: Boolean) {
    val local =
      localIpv4.addresses()
        ?: fail(if (afterPairing) TunnelFailure.PairingConflictUnknown else TunnelFailure.RouteInspectionUnavailable)
    when (addressConflict(address, remote, local)) {
      null -> return
      AddressConflict.LocalAddress ->
        if (afterPairing) fail(TunnelFailure.PairingConflictUnknown) else fail(TunnelFailure.LocalAddressConflict)
      AddressConflict.PeerAddress ->
        if (afterPairing) fail(TunnelFailure.PairingConflictUnknown) else fail(TunnelFailure.ReceiverRouteConflict)
    }
  }

  private fun pairedConfig(message: WorkletMessage): ManagedConfig {
    val address = message.address ?: fail(TunnelFailure.PairingUnknown)
    val receiverAddress = message.receiverAddress ?: fail(TunnelFailure.PairingUnknown)
    val receiverKey = message.receiverKey ?: fail(TunnelFailure.PairingUnknown)
    val element =
      buildJsonObject {
        put("address", address)
        put("receiverAddress", receiverAddress)
        put("receiverKey", receiverKey)
      }
    return ManagedConfig.parse(element) ?: fail(TunnelFailure.PairingUnknown)
  }

  private fun pairFailure(reason: String?): TunnelFailure =
    when (reason) {
      "unusable" -> TunnelFailure.Invitation
      "unavailable" -> TunnelFailure.ReceiverUnavailable
      "capacity" -> TunnelFailure.Capacity
      "pool" -> TunnelFailure.Pool
      "route" -> TunnelFailure.ReceiverRouteConflict
      "excluded" -> TunnelFailure.ExcludedAddress
      else -> TunnelFailure.PairingUnknown
    }

  private fun seedHex(): String = Hex.encode(seed ?: fail(TunnelFailure.Identity))

  internal companion object {
    /** Bounded frames in flight; packets beyond this are dropped, never queued. */
    const val OUTBOUND_LIMIT = 32
  }
}
