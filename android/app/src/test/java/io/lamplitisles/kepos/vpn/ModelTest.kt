package io.lamplitisles.kepos.vpn

import kotlinx.coroutines.ExperimentalCoroutinesApi
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ModelTest {
  @Test
  fun `internal failures map to fixed UI errors`() {
    val paired =
      mapOf(
        TunnelFailure.Configuration to PeerVpnError.LocalState,
        TunnelFailure.LocalState to PeerVpnError.LocalState,
        TunnelFailure.Identity to PeerVpnError.LocalState,
        TunnelFailure.WorkletUnavailable to PeerVpnError.ProviderUnavailable,
        TunnelFailure.Bridge to PeerVpnError.ProviderUnavailable,
        TunnelFailure.Timeout to PeerVpnError.ProviderUnavailable,
        TunnelFailure.Invitation to PeerVpnError.UnusableInvitation,
        TunnelFailure.PairingNotSubmitted to PeerVpnError.ProviderUnavailable,
        TunnelFailure.ReceiverUnavailable to PeerVpnError.ReceiverUnavailable,
        TunnelFailure.PairingUnknown to PeerVpnError.PairingOutcomeUnknown,
        TunnelFailure.Permission to PeerVpnError.VpnPermissionRequired,
        TunnelFailure.IdentityInUse to PeerVpnError.IdentityInUse,
        TunnelFailure.Capacity to PeerVpnError.ReceiverCapacity,
        TunnelFailure.Pool to PeerVpnError.ReceiverCapacity,
        TunnelFailure.ReceiverRouteConflict to PeerVpnError.ReceiverRouteConflict,
        TunnelFailure.LocalAddressConflict to PeerVpnError.LocalAddressConflict,
        TunnelFailure.RouteInspectionUnavailable to PeerVpnError.RouteInspectionUnavailable,
        TunnelFailure.PairingConflictUnknown to PeerVpnError.PairingConflictUnknown,
        TunnelFailure.ExcludedAddress to PeerVpnError.ReceiverExcludedAddress,
        TunnelFailure.RouteInspectionBeforePair to PeerVpnError.RouteInspectionUnavailable,
      )
    for ((reason, error) in paired) assertEquals(error, reason.toError(pairing = false))

    // An ambiguous pairing failure must never look like a clean rejection.
    assertEquals(PeerVpnError.PairingOutcomeUnknown, TunnelFailure.Bridge.toError(pairing = true))
    assertEquals(PeerVpnError.PairingOutcomeUnknown, TunnelFailure.Timeout.toError(pairing = true))
    assertEquals(PeerVpnError.PairingConflictUnknown, TunnelFailure.LocalAddressConflict.toError(pairing = true))
    assertEquals(PeerVpnError.PairingOutcomeUnknown, TunnelFailure.RouteInspectionUnavailable.toError(pairing = true))
    assertEquals(PeerVpnError.UnusableInvitation, TunnelFailure.Invitation.toError(pairing = true))
    // Nothing left the device, so this must not look like an unknown pairing.
    assertEquals(PeerVpnError.ProviderUnavailable, TunnelFailure.PairingNotSubmitted.toError(pairing = true))
    assertEquals(PeerVpnError.ReceiverCapacity, TunnelFailure.Pool.toError(pairing = true))
  }

  @OptIn(ExperimentalCoroutinesApi::class)
  @Test
  fun `an operation completes exactly once with its outcome`() {
    val operation = PeerVpnRuntime.begin(Phase.Pairing)
    assertEquals(Phase.Pairing, PeerVpnRuntime.state.value.phase)
    PeerVpnRuntime.finished(operation, OperationOutcome.Failed(PeerVpnError.UnusableInvitation))
    assertEquals(OperationOutcome.Failed(PeerVpnError.UnusableInvitation), operation.result.getCompleted())
    assertEquals(Phase.Idle, PeerVpnRuntime.state.value.phase)
    assertNull(PeerVpnRuntime.state.value.peers)
    assertEquals(PeerVpnError.UnusableInvitation, PeerVpnRuntime.state.value.failure)

    // A second completion of the same attempt is ignored.
    PeerVpnRuntime.finished(operation, OperationOutcome.Success)
    assertEquals(PeerVpnError.UnusableInvitation, PeerVpnRuntime.state.value.failure)
  }

  @OptIn(ExperimentalCoroutinesApi::class)
  @Test
  fun `a stale operation never changes the current one`() {
    val first = PeerVpnRuntime.begin(Phase.Pairing)
    val second = PeerVpnRuntime.begin(Phase.Connecting)
    assertNull(PeerVpnRuntime.adopt(first.epoch))
    assertEquals(second, PeerVpnRuntime.adopt(second.epoch))

    PeerVpnRuntime.connected(first)
    assertFalse(first.result.isCompleted)
    assertEquals(Phase.Connecting, PeerVpnRuntime.state.value.phase)

    PeerVpnRuntime.connected(second)
    assertEquals(OperationOutcome.Success, second.result.getCompleted())
    assertEquals(Phase.Connected, PeerVpnRuntime.state.value.phase)

    PeerVpnRuntime.finished(first, OperationOutcome.Failed(PeerVpnError.ProviderUnavailable))
    assertEquals(Phase.Connected, PeerVpnRuntime.state.value.phase)

    PeerVpnRuntime.finished(second, OperationOutcome.Cancelled)
    assertEquals(Phase.Idle, PeerVpnRuntime.state.value.phase)
    assertNull(PeerVpnRuntime.state.value.failure)
  }

  @OptIn(ExperimentalCoroutinesApi::class)
  @Test
  fun `abandoning an operation clears it and ignores later callbacks`() {
    val operation = PeerVpnRuntime.begin(Phase.Pairing)
    PeerVpnRuntime.abandon(operation, PeerVpnError.PairingOutcomeUnknown)
    assertEquals(OperationOutcome.Cancelled, operation.result.getCompleted())
    assertEquals(Phase.Idle, PeerVpnRuntime.state.value.phase)
    assertEquals(PeerVpnError.PairingOutcomeUnknown, PeerVpnRuntime.state.value.failure)

    PeerVpnRuntime.finished(operation, OperationOutcome.Success)
    assertEquals(PeerVpnError.PairingOutcomeUnknown, PeerVpnRuntime.state.value.failure)
  }

  @Test
  fun `the configured peer list is published while connecting and kept`() {
    val operation = PeerVpnRuntime.begin(Phase.Connecting)
    val peer = PeerStatus("f".repeat(64), "receiver", connected = false)
    PeerVpnRuntime.publishPeers(operation, listOf(peer))
    assertEquals(listOf(VpnPeer(peer.publicKey, "receiver", connected = false)), PeerVpnRuntime.state.value.peers)

    PeerVpnRuntime.connected(operation)
    val connectedPeer = peer.copy(connected = true)
    PeerVpnRuntime.publishPeers(operation, listOf(connectedPeer))
    assertEquals(listOf(VpnPeer(peer.publicKey, "receiver", connected = true)), PeerVpnRuntime.state.value.peers)

    PeerVpnRuntime.finished(operation, OperationOutcome.Cancelled)
    assertNull(PeerVpnRuntime.state.value.peers)
    assertNull(PeerVpnRuntime.state.value.failure)
    assertEquals(Phase.Idle, PeerVpnRuntime.state.value.phase)
  }

  @OptIn(ExperimentalCoroutinesApi::class)
  @Test
  fun `peer status from another attempt is ignored`() {
    val first = PeerVpnRuntime.begin(Phase.Connecting)
    val second = PeerVpnRuntime.begin(Phase.Connecting)
    val stale = PeerStatus("1".repeat(64), "stale", connected = true)
    val current = PeerStatus("2".repeat(64), "receiver", connected = false)

    PeerVpnRuntime.connected(second)
    PeerVpnRuntime.publishPeers(second, listOf(current))
    PeerVpnRuntime.publishPeers(first, listOf(stale))

    assertEquals(listOf(VpnPeer(current.publicKey, "receiver", connected = false)), PeerVpnRuntime.state.value.peers)
    assertFalse(first.result.isCompleted)
    PeerVpnRuntime.finished(second, OperationOutcome.Cancelled)
    PeerVpnRuntime.publishPeers(first, listOf(stale))
    assertNull(PeerVpnRuntime.state.value.peers)
  }

  @Test
  fun `an invitation is only marked submitted for the current attempt`() {
    val first = PeerVpnRuntime.begin(Phase.Pairing)
    val second = PeerVpnRuntime.begin(Phase.Pairing)
    PeerVpnRuntime.invitationSubmitted(first)
    assertFalse(first.invitationSubmitted)
    PeerVpnRuntime.invitationSubmitted(second)
    assertTrue(second.invitationSubmitted)
  }

  @Test
  fun `a stop only targets its own attempt`() {
    assertTrue(stopTargetsAttempt(7L, 7L))
    assertFalse(stopTargetsAttempt(7L, 8L))
    // A stop without an attempt, or with nothing running, is allowed.
    assertTrue(stopTargetsAttempt(null, 8L))
    assertTrue(stopTargetsAttempt(7L, null))
  }
}
