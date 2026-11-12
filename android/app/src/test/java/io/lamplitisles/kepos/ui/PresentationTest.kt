package io.lamplitisles.kepos.ui

import io.lamplitisles.kepos.vpn.PeerVpnError
import io.lamplitisles.kepos.vpn.PeerVpnState
import io.lamplitisles.kepos.vpn.Phase
import io.lamplitisles.kepos.vpn.VpnPeer
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.yield
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PresentationTest {
  @Test fun `unknown pairing requires receiver check`() {
    assertTrue(isUnknownPairing(PeerVpnError.PairingOutcomeUnknown))
    assertTrue(isUnknownPairing(PeerVpnError.PairingConflictUnknown))
    assertFalse(isUnknownPairing(PeerVpnError.UnusableInvitation))
    assertTrue(errorMessage(PeerVpnError.PairingOutcomeUnknown).contains("check authorized devices"))
  }

  @Test fun `connected tunnel does not imply connected receiver`() {
    val state = PeerVpnState(publicKey = "test", paired = true, phase = Phase.Connected)
    assertEquals("VPN on", vpnTitle(state.phase))
    assertEquals("Receiver status unavailable", receiverTitle(state))
    assertEquals("Receiver not connected", receiverTitle(state.copy(peers = emptyList())))
    assertEquals("Receiver connected", receiverTitle(state.copy(peers = listOf(VpnPeer("test", "test", true)))))
  }

  @Test fun `configured receiver is not presented as connected when VPN is off`() {
    assertEquals("Receiver configured", receiverTitle(PeerVpnState(publicKey = "test", paired = true)))
    assertEquals("Setup needed", receiverTitle(PeerVpnState()))
  }

  @Test fun `an unpaired local state failure offers a recheck before another invitation`() {
    val failed = PeerVpnState(publicKey = "test", failure = PeerVpnError.LocalState)
    assertTrue(needsStateRecheck(failed))
    assertFalse(needsStateRecheck(failed.copy(failure = null)))
    assertFalse(needsStateRecheck(failed.copy(paired = true)))
    assertFalse(needsStateRecheck(failed.copy(phase = Phase.Pairing)))
  }

  @Test fun `a suspended recheck stays active and ignores repeated requests`() = runTest {
    val recheck = IdentityRecheck()
    val release = CompletableDeferred<Unit>()
    var calls = 0
    recheck.start(this) { calls++; release.await() }
    recheck.start(this) { calls++ }
    assertTrue(recheck.running)
    yield()
    assertEquals(1, calls)
    assertTrue(recheck.running)
    release.complete(Unit)
    yield()
    assertFalse(recheck.running)
  }
}
