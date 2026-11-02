import Foundation

func expect(_ condition: @autoclosure () -> Bool, _ message: String) {
    if !condition() { fatalError(message) }
}
let peer = VPNPeerStatus(publicKey: "test", label: "home", connected: true)
let missing = MenuPresentation(status: VPNStatus(provider: .disconnected, peers: nil, error: nil),
                               hasConfig: false, hasIdentity: false, busy: false)
expect(!missing.canConnect && missing.canConfigure, "configuration must be selected first")
expect(missing.peerTitles == ["Peer status unavailable"], "unavailable peer state must not look connected")
let stale = MenuPresentation(status: VPNStatus(provider: .disconnected, peers: [peer], error: nil),
                             hasConfig: true, hasIdentity: true, busy: false)
expect(stale.peerTitles == ["home: Disconnected"], "a stopped provider must not show a connected peer")
let running = MenuPresentation(status: VPNStatus(provider: .running, peers: [peer], error: nil),
                               hasConfig: true, hasIdentity: true, busy: false)
expect(running.statusTitle == "VPN: On" && running.peerTitles == ["home: Connected"], "provider and peer must be distinct")
expect(!running.canConnect && running.canDisconnect && !running.canConfigure, "running tunnel actions")
let connecting = MenuPresentation(status: VPNStatus(provider: .connecting, peers: [], error: nil),
                                  hasConfig: true, hasIdentity: true, busy: false)
expect(connecting.canDisconnect && !connecting.canConnect, "connecting tunnel can be stopped")
let busy = MenuPresentation(status: VPNStatus(provider: .disconnected, peers: [], error: nil),
                            hasConfig: true, hasIdentity: true, busy: true)
expect(!busy.canConnect && !busy.canConfigure && !busy.canDisconnect, "pending action excludes another action")
print("menu presentation tests passed")
