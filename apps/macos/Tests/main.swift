import Foundation

func expect(_ condition: @autoclosure () -> Bool, _ message: String) {
    if !condition() { fatalError(message) }
}

let stopped = VPNStatus(provider: .disconnected, peers: nil, error: nil)
let unpaired = ManagedState(publicKey: "test-key", paired: false)
let paired = ManagedState(publicKey: "test-key", paired: true)
let peer = VPNPeerStatus(publicKey: "test-key", label: "home", connected: true)

let missing = MenuPresentation(status: stopped, managed: nil, busy: false, pairing: false)
expect(!missing.canConnect && !missing.canPair && missing.canRetrySetup, "missing managed state can only be retried")
expect(!missing.canCopyPublicKey, "no key is available before setup")

expect(pairingRequiresRecheck(.outcomeUnknown), "lost pairing result requires local recheck")
expect(pairingRequiresRecheck(.pairingConflictUnknown), "post-admission conflict requires local recheck")
expect(pairingRequiresRecheck(nil), "unexpected pairing errors require local recheck")
expect(!pairingRequiresRecheck(.unusableInvitation), "known rejection does not invalidate local state")

var notices = MenuNotices()
notices.fail("provider unavailable", uncertainPairing: false)
notices.beginAction()
expect(notices.actionError == nil, "successful setup retry clears an ordinary error")
notices.fail("inspect receiver", uncertainPairing: true)
notices.beginAction()
notices.fail("storage unavailable", uncertainPairing: false)
expect(notices.pairingWarning == "inspect receiver" && notices.actionError == "storage unavailable",
       "failed recheck preserves the pairing warning alongside its current error")
notices.beginAction()
notices.fail("provider unavailable", uncertainPairing: false)
expect(notices.pairingWarning == "inspect receiver" && notices.actionError == "provider unavailable",
       "another retry replaces the ordinary error without losing the pairing warning")
notices.beginAction()
expect(notices.pairingWarning == "inspect receiver" && notices.actionError == nil,
       "a successful local recheck does not resolve the receiver outcome")
notices.clearPairingWarning()
expect(notices.pairingWarning == nil, "the user can dismiss the pairing warning")

let ready = MenuPresentation(status: stopped, managed: unpaired, busy: false, pairing: false)
expect(!ready.canConnect && ready.canPair && ready.canCopyPublicKey, "unpaired identity can pair or copy its key")

let disconnected = MenuPresentation(status: VPNStatus(provider: .disconnected, peers: [peer], error: nil),
                                    managed: paired, busy: false, pairing: false)
expect(disconnected.canConnect && disconnected.canPair && !disconnected.canDisconnect, "paired device can connect while stopped")
expect(disconnected.peerTitles == ["home: Disconnected"], "stale peer cannot appear connected")

let running = MenuPresentation(status: VPNStatus(provider: .running, peers: [peer], error: nil),
                               managed: paired, busy: false, pairing: false)
expect(running.peerTitles == ["home: Connected"], "provider and peer remain distinct")
expect(!running.canConnect && running.canDisconnect && !running.canPair, "running tunnel cannot pair")

let connecting = MenuPresentation(status: VPNStatus(provider: .connecting, peers: nil, error: nil),
                                  managed: paired, busy: false, pairing: false)
expect(connecting.canDisconnect && !connecting.canConnect && !connecting.canPair, "normal connecting can be stopped")

let pairing = MenuPresentation(status: VPNStatus(provider: .connecting, peers: nil, error: nil),
                               managed: unpaired, busy: true, pairing: true)
expect(!pairing.canConnect && !pairing.canDisconnect && !pairing.canPair && !pairing.canCopyPublicKey,
       "in-flight pairing cannot be cancelled or repeated from the menu")
expect(pairing.statusTitle != connecting.statusTitle, "temporary provider transitions do not imply normal connection")

let pairedAndReady = MenuPresentation(status: stopped, managed: paired, busy: false, pairing: false)
expect(pairedAndReady.peerTitles == ["Paired with receiver — ready to connect"], "successful pairing is visible before connection")

let unavailable = MenuPresentation(status: VPNStatus(provider: .running, peers: nil, error: nil),
                                   managed: paired, busy: false, pairing: false)
expect(unavailable.peerTitles == ["Peer status unavailable"], "unknown peer state must not appear connected")
print("menu presentation tests passed")
