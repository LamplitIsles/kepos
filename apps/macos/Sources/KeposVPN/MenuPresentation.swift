import Foundation

/// User-facing menu state; a running provider does not imply a connected peer.
struct MenuPresentation {
    let statusTitle: String
    let peerTitles: [String]
    let canConnect: Bool
    let canDisconnect: Bool
    let canConfigure: Bool

    init(status: VPNStatus, hasConfig: Bool, hasIdentity: Bool, busy: Bool) {
        switch status.provider {
        case .disconnected: statusTitle = "VPN: Disconnected"
        case .connecting: statusTitle = "VPN: Connecting…"
        case .running: statusTitle = "VPN: On"
        case .disconnecting: statusTitle = "VPN: Disconnecting…"
        case .failed: statusTitle = "VPN: Failed"
        }

        if let peers = status.peers {
            peerTitles = peers.isEmpty
                ? ["No peers configured"]
                : peers.map { "\($0.label): \($0.connected && status.provider == .running ? "Connected" : "Disconnected")" }
        } else {
            peerTitles = ["Peer status unavailable"]
        }

        let stopped = status.provider == .disconnected || status.provider == .failed
        canConfigure = stopped && !busy
        canConnect = stopped && !busy && hasConfig && hasIdentity
        canDisconnect = !busy && (status.provider == .running || status.provider == .connecting)
    }
}
