package io.lamplitisles.kepos.vpn

import java.io.File
import java.nio.file.Files
import java.nio.file.attribute.PosixFilePermissions
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.yield
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private val PUBLIC_KEY = "a".repeat(64)
private val INVITATION = "kepos1:${"b".repeat(64)}:${"c".repeat(64)}"

private class FakeBoundary : VpnBoundary {
  var consent = false
  var startPairResult = true
  var startConnectResult = true
  var stopResult = true
  var prepared = ManagedState(PUBLIC_KEY, paired = false)
  var prepareFailure: VpnFailure? = null

  /** Reads the real state instead of reporting a canned result. */
  var prepareOverride: (() -> ManagedState)? = null

  /** Result of the durable pending-marker removal. */
  var clearPairingPending = true
  var stops = 0
  val stopEpochs = mutableListOf<Long?>()
  var pairEpoch: Long? = null
  var connectEpoch: Long? = null

  override fun consentIntent() = null

  override fun consentGranted() = consent

  override fun prepareIdentity(): ManagedState {
    prepareOverride?.let { return it() }
    prepareFailure?.let { throw it }
    return prepared
  }

  override fun clearPairingPending(): Boolean = clearPairingPending

  override fun startPair(epoch: Long, invitation: String): Boolean {
    pairEpoch = epoch
    return startPairResult
  }

  override fun startConnect(epoch: Long): Boolean {
    connectEpoch = epoch
    return startConnectResult
  }

  override fun stop(epoch: Long?): Boolean {
    stops += 1
    stopEpochs += epoch
    return stopResult
  }
}

/**
 * Drives the real controller against a fake service boundary. The service is
 * simulated by completing the operation it would have adopted.
 */
class ControllerTest {
  private fun controller(boundary: FakeBoundary, pairMillis: Long = 5_000, connectMillis: Long = 5_000) =
    PeerVpnController(boundary, PeerVpnController.Timeouts(pairMillis = pairMillis, connectMillis = connectMillis))

  private fun adopt(epoch: Long?): Operation {
    val value = epoch ?: error("the service was not started")
    return PeerVpnRuntime.adopt(value) ?: error("the operation is not current")
  }

  @Test
  fun `an unreadable identity file is reported as local state`() {
    TempRoot().use { root ->
      IdentityStore(root.directory).prepare()
      val boundary = FakeBoundary().apply { prepareOverride = { PeerState(root.directory).prepare() } }
      val controller = controller(boundary)
      val seed = File(root.directory, "peer/peer.json").toPath()
      Files.setPosixFilePermissions(seed, PosixFilePermissions.fromString("rw-r--r--"))

      // The identity read fails; the caller gets a state failure, not an exception.
      assertEquals(PeerVpnError.LocalState, runBlocking { controller.prepareIdentity() })
      controller.dismissFailure()
    }
  }

  @Test
  fun `an unconfirmed pairing is reported from the durable marker`() {
    val boundary = FakeBoundary().apply { prepared = ManagedState(PUBLIC_KEY, paired = false, pairingPending = true) }
    val controller = controller(boundary)

    assertEquals(PeerVpnError.PairingOutcomeUnknown, runBlocking { controller.prepareIdentity() })
    assertEquals(PeerVpnError.PairingOutcomeUnknown, PeerVpnRuntime.state.value.failure)
    controller.dismissFailure()
  }

  @Test
  fun `acknowledging clears the marker before the warning`() {
    val boundary = FakeBoundary().apply { prepared = ManagedState(PUBLIC_KEY, paired = false, pairingPending = true) }
    val controller = controller(boundary)
    runBlocking { controller.prepareIdentity() }

    assertNull(runBlocking { controller.acknowledgeUnknownPairing() })
    assertNull(PeerVpnRuntime.state.value.failure)
  }

  @Test
  fun `a failed acknowledgement keeps the unknown warning`() {
    val boundary =
      FakeBoundary().apply {
        prepared = ManagedState(PUBLIC_KEY, paired = false, pairingPending = true)
        clearPairingPending = false
      }
    val controller = controller(boundary)
    runBlocking { controller.prepareIdentity() }

    assertEquals(PeerVpnError.LocalState, runBlocking { controller.acknowledgeUnknownPairing() })
    assertEquals(PeerVpnError.PairingOutcomeUnknown, PeerVpnRuntime.state.value.failure)
    controller.dismissFailure()
  }

  @Test
  fun `pairing success is not reported as a timeout`() = runTest {
    val boundary = FakeBoundary()
    val controller = controller(boundary)
    var result: PeerVpnError? = PeerVpnError.LocalState
    val job = launch { result = controller.pair(INVITATION) }
    withTimeout(2_000) {
      while (boundary.pairEpoch == null) yield()
    }
    val operation = adopt(boundary.pairEpoch)
    PeerVpnRuntime.identity(operation, ManagedState(PUBLIC_KEY, paired = true))
    PeerVpnRuntime.finished(operation, OperationOutcome.Success)
    job.join()

    assertNull(result)
    assertEquals(0, boundary.stops)
    assertEquals(Phase.Idle, PeerVpnRuntime.state.value.phase)
    assertTrue(PeerVpnRuntime.state.value.paired)
    assertEquals(PUBLIC_KEY, PeerVpnRuntime.state.value.publicKey)
    assertNull(PeerVpnRuntime.state.value.failure)
  }

  @Test
  fun `a connected tunnel stays connected after the waiting call returns`() = runTest {
    val boundary = FakeBoundary().apply { consent = true }
    val controller = controller(boundary)
    PeerVpnRuntime.identity(ManagedState(PUBLIC_KEY, paired = true))
    controller.refreshConsent()

    var result: PeerVpnError? = PeerVpnError.LocalState
    val job = launch { result = controller.connect() }
    withTimeout(2_000) {
      while (boundary.connectEpoch == null) yield()
    }
    val operation = adopt(boundary.connectEpoch)
    PeerVpnRuntime.connected(operation)
    job.join()

    assertNull(result)
    assertEquals(0, boundary.stops)
    assertEquals(Phase.Connected, PeerVpnRuntime.state.value.phase)

    PeerVpnRuntime.publishPeers(operation, listOf(PeerStatus(PUBLIC_KEY, "receiver", connected = true)))
    assertEquals(listOf(VpnPeer(PUBLIC_KEY, "receiver", connected = true)), PeerVpnRuntime.state.value.peers)

    // The user disconnects later: the same operation ends without a failure.
    PeerVpnRuntime.finished(operation, OperationOutcome.Cancelled)
    assertEquals(Phase.Idle, PeerVpnRuntime.state.value.phase)
    assertNull(PeerVpnRuntime.state.value.failure)
    assertNull(PeerVpnRuntime.state.value.peers)
  }

  @Test
  fun `a failed connection is reported and leaves no operation behind`() = runTest {
    val boundary = FakeBoundary().apply { consent = true }
    val controller = controller(boundary)
    PeerVpnRuntime.identity(ManagedState(PUBLIC_KEY, paired = true))
    controller.refreshConsent()

    var result: PeerVpnError? = null
    val job = launch { result = controller.connect() }
    withTimeout(2_000) {
      while (boundary.connectEpoch == null) yield()
    }
    val operation = adopt(boundary.connectEpoch)
    PeerVpnRuntime.finished(operation, OperationOutcome.Failed(PeerVpnError.ReceiverUnavailable))
    job.join()

    assertEquals(PeerVpnError.ReceiverUnavailable, result)
    assertEquals(Phase.Idle, PeerVpnRuntime.state.value.phase)
    assertEquals(PeerVpnError.ReceiverUnavailable, PeerVpnRuntime.state.value.failure)
  }

  @Test
  fun `a silent service times out, is stopped, and cannot report late`() = runTest {
    val boundary = FakeBoundary()
    val controller = controller(boundary, pairMillis = 10)
    var result: PeerVpnError? = null
    val job = launch { result = controller.pair(INVITATION) }
    withTimeout(2_000) {
      while (boundary.pairEpoch == null) yield()
    }
    val operation = adopt(boundary.pairEpoch)
    job.join()

    assertEquals(PeerVpnError.PairingOutcomeUnknown, result)
    assertEquals(1, boundary.stops)
    assertEquals(listOf(operation.epoch), boundary.stopEpochs)
    assertEquals(Phase.Idle, PeerVpnRuntime.state.value.phase)
    assertEquals(PeerVpnError.PairingOutcomeUnknown, PeerVpnRuntime.state.value.failure)

    // A late completion of the abandoned attempt must not change anything.
    PeerVpnRuntime.finished(operation, OperationOutcome.Success)
    assertEquals(Phase.Idle, PeerVpnRuntime.state.value.phase)
    assertEquals(PeerVpnError.PairingOutcomeUnknown, PeerVpnRuntime.state.value.failure)
  }

  @Test
  fun `an unused connection attempt times out without staying connecting`() = runTest {
    val boundary = FakeBoundary().apply { consent = true }
    val controller = controller(boundary, connectMillis = 10)
    PeerVpnRuntime.identity(ManagedState(PUBLIC_KEY, paired = true))
    controller.refreshConsent()

    var result: PeerVpnError? = null
    val job = launch { result = controller.connect() }
    withTimeout(2_000) {
      while (boundary.connectEpoch == null) yield()
    }
    job.join()

    assertEquals(PeerVpnError.ProviderUnavailable, result)
    assertEquals(1, boundary.stops)
    assertEquals(Phase.Idle, PeerVpnRuntime.state.value.phase)
  }

  @Test
  fun `cancelling a pairing that may have reached the receiver keeps an unknown outcome`() = runTest {
    val boundary = FakeBoundary()
    val controller = controller(boundary)
    val job = launch { controller.pair(INVITATION) }
    withTimeout(2_000) {
      while (boundary.pairEpoch == null) yield()
    }
    val operation = adopt(boundary.pairEpoch)
    PeerVpnRuntime.invitationSubmitted(operation)
    job.cancel()
    job.join()

    // The service is asked to stop exactly this attempt.
    assertEquals(listOf(operation.epoch), boundary.stopEpochs)
    assertEquals(Phase.Idle, PeerVpnRuntime.state.value.phase)
    assertEquals(PeerVpnError.PairingOutcomeUnknown, PeerVpnRuntime.state.value.failure)
  }

  @Test
  fun `cancelling before the invitation is queued reports no failure`() = runTest {
    val boundary = FakeBoundary()
    val controller = controller(boundary)
    val job = launch { controller.pair(INVITATION) }
    withTimeout(2_000) {
      while (boundary.pairEpoch == null) yield()
    }
    job.cancel()
    job.join()

    assertEquals(1, boundary.stops)
    assertEquals(Phase.Idle, PeerVpnRuntime.state.value.phase)
    assertNull(PeerVpnRuntime.state.value.failure)
  }

  @Test
  fun `cancelling a connection stops the attempt`() = runTest {
    val boundary = FakeBoundary().apply { consent = true }
    val controller = controller(boundary)
    PeerVpnRuntime.identity(ManagedState(PUBLIC_KEY, paired = true))
    controller.refreshConsent()

    val job = launch { controller.connect() }
    withTimeout(2_000) {
      while (boundary.connectEpoch == null) yield()
    }
    val operation = adopt(boundary.connectEpoch)
    job.cancel()
    job.join()

    assertEquals(listOf(operation.epoch), boundary.stopEpochs)
    assertEquals(Phase.Idle, PeerVpnRuntime.state.value.phase)
    assertNull(PeerVpnRuntime.state.value.failure)
  }

  @Test
  fun `a cancelled attempt that cannot be stopped stays closable`() = runTest {
    val boundary = FakeBoundary().apply { stopResult = false }
    val controller = controller(boundary)
    val job = launch { controller.pair(INVITATION) }
    withTimeout(2_000) {
      while (boundary.pairEpoch == null) yield()
    }
    val operation = adopt(boundary.pairEpoch)
    PeerVpnRuntime.invitationSubmitted(operation)
    job.cancel()
    job.join()

    // No stop was dispatched, so the attempt stays visible instead of claiming
    // the tunnel is gone.
    assertEquals(Phase.Pairing, PeerVpnRuntime.state.value.phase)
    assertEquals(PeerVpnError.ProviderUnavailable, PeerVpnRuntime.state.value.failure)
    assertEquals(operation, PeerVpnRuntime.adopt(operation.epoch))

    // The user can still stop it.
    boundary.stopResult = true
    controller.disconnect()
    assertEquals(2, boundary.stops)
    assertEquals(Phase.Disconnecting, PeerVpnRuntime.state.value.phase)
    PeerVpnRuntime.finished(operation, OperationOutcome.Cancelled)
    assertEquals(Phase.Idle, PeerVpnRuntime.state.value.phase)
  }

  @Test
  fun `a timed-out pairing that cannot be stopped keeps the attempt closable`() = runTest {
    val boundary = FakeBoundary().apply { stopResult = false }
    val controller = controller(boundary, pairMillis = 10)
    var result: PeerVpnError? = null
    val job = launch { result = controller.pair(INVITATION) }
    withTimeout(2_000) {
      while (boundary.pairEpoch == null) yield()
    }
    val operation = adopt(boundary.pairEpoch)
    job.join()

    // The stop was refused, so the attempt is still running: it must not be
    // reported as idle, and it must remain stoppable.
    assertEquals(PeerVpnError.ProviderUnavailable, result)
    assertEquals(Phase.Pairing, PeerVpnRuntime.state.value.phase)
    assertEquals(PeerVpnError.ProviderUnavailable, PeerVpnRuntime.state.value.failure)
    assertEquals(operation, PeerVpnRuntime.adopt(operation.epoch))

    boundary.stopResult = true
    controller.disconnect()
    assertEquals(2, boundary.stops)
    assertEquals(Phase.Disconnecting, PeerVpnRuntime.state.value.phase)
    PeerVpnRuntime.finished(operation, OperationOutcome.Cancelled)
    assertEquals(Phase.Idle, PeerVpnRuntime.state.value.phase)
  }

  @Test
  fun `a timed-out connection that cannot be stopped keeps the attempt closable`() = runTest {
    val boundary = FakeBoundary().apply { consent = true; stopResult = false }
    val controller = controller(boundary, connectMillis = 10)
    PeerVpnRuntime.identity(ManagedState(PUBLIC_KEY, paired = true))
    controller.refreshConsent()

    var result: PeerVpnError? = null
    val job = launch { result = controller.connect() }
    withTimeout(2_000) {
      while (boundary.connectEpoch == null) yield()
    }
    val operation = adopt(boundary.connectEpoch)
    job.join()

    assertEquals(PeerVpnError.ProviderUnavailable, result)
    assertEquals(Phase.Connecting, PeerVpnRuntime.state.value.phase)
    assertEquals(operation, PeerVpnRuntime.adopt(operation.epoch))

    boundary.stopResult = true
    controller.disconnect()
    assertEquals(2, boundary.stops)
    PeerVpnRuntime.finished(operation, OperationOutcome.Cancelled)
    assertEquals(Phase.Idle, PeerVpnRuntime.state.value.phase)
  }

  @Test
  fun `a rejected service start clears the operation and a retry still works`() = runTest {
    val boundary = FakeBoundary().apply { startPairResult = false }
    val controller = controller(boundary)

    val first = controller.pair(INVITATION)
    assertEquals(PeerVpnError.ProviderUnavailable, first)
    assertEquals(Phase.Idle, PeerVpnRuntime.state.value.phase)
    assertNull(PeerVpnRuntime.adopt(boundary.pairEpoch!!))

    boundary.startPairResult = true
    var second: PeerVpnError? = PeerVpnError.LocalState
    val job = launch { second = controller.pair(INVITATION) }
    withTimeout(2_000) {
      while (boundary.pairEpoch == 0L || PeerVpnRuntime.adopt(boundary.pairEpoch!!) == null) yield()
    }
    val operation = adopt(boundary.pairEpoch)
    PeerVpnRuntime.finished(operation, OperationOutcome.Success)
    job.join()
    assertNull(second)
  }

  @Test
  fun `an operation is refused while another is running`() = runTest {
    val boundary = FakeBoundary()
    val controller = controller(boundary)
    val operation = PeerVpnRuntime.begin(Phase.Pairing)
    assertEquals(PeerVpnError.Busy, controller.pair(INVITATION))
    assertEquals(PeerVpnError.Busy, controller.connect())
    assertNull(boundary.pairEpoch)
    assertNull(boundary.connectEpoch)
    PeerVpnRuntime.abandon(operation, null)
  }

  @Test
  fun `a failed disconnect dispatch reports the tunnel as still connected`() = runTest {
    val boundary = FakeBoundary().apply { stopResult = false }
    val controller = controller(boundary)
    PeerVpnRuntime.begin(Phase.Connecting)
    PeerVpnRuntime.update { it.copy(phase = Phase.Connected) }

    controller.disconnect()

    assertEquals(Phase.Connected, PeerVpnRuntime.state.value.phase)
    assertEquals(PeerVpnError.ProviderUnavailable, PeerVpnRuntime.state.value.failure)
  }

  @Test
  fun `a stale operation cannot overwrite the next attempt`() = runTest {
    val boundary = FakeBoundary()
    val controller = controller(boundary)
    val first = PeerVpnRuntime.begin(Phase.Pairing)
    PeerVpnRuntime.abandon(first, PeerVpnError.PairingOutcomeUnknown)

    var result: PeerVpnError? = PeerVpnError.LocalState
    val job = launch { result = controller.pair(INVITATION) }
    withTimeout(2_000) {
      while (boundary.pairEpoch == null) yield()
    }
    val second = adopt(boundary.pairEpoch)

    PeerVpnRuntime.finished(first, OperationOutcome.Success)
    assertEquals(Phase.Pairing, PeerVpnRuntime.state.value.phase)

    PeerVpnRuntime.finished(second, OperationOutcome.Success)
    job.join()
    assertNull(result)
    assertEquals(Phase.Idle, PeerVpnRuntime.state.value.phase)
  }
}
