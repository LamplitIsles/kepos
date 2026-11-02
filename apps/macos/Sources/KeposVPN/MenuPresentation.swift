import Foundation

/// A lost pairing result requires a fresh local read and receiver inspection.
func pairingRequiresRecheck(_ error: ManagedVPNError?) -> Bool {
    error == nil || error == .outcomeUnknown || error == .pairingConflictUnknown
}

struct MenuNotices {
    private(set) var pairingWarning: String?
    private(set) var actionError: String?

    mutating func beginAction() { actionError = nil }

    mutating func fail(_ message: String, uncertainPairing: Bool) {
        if uncertainPairing { pairingWarning = message }
        else { actionError = message }
    }

    mutating func clearPairingWarning() { pairingWarning = nil }
}

/// A running provider does not imply an authenticated receiver connection.
struct MenuPresentation {
    let statusTitle: String
    let peerTitles: [String]
    let canConnect: Bool
    let canDisconnect: Bool
    let canPair: Bool
    let canRetrySetup: Bool
    let canCopyPublicKey: Bool

    init(status: VPNStatus, managed: ManagedState?, busy: Bool, pairing: Bool) {
        if pairing {
            statusTitle = "Pairing…"
        } else if busy && managed == nil {
            statusTitle = "Preparing Kepos…"
        } else {
            switch status.provider {
            case .disconnected: statusTitle = "VPN: Disconnected"
            case .connecting: statusTitle = "VPN: Connecting…"
            case .running: statusTitle = "VPN: On"
            case .disconnecting: statusTitle = "VPN: Disconnecting…"
            case .failed: statusTitle = "VPN: Failed"
            }
        }

        if managed?.paired == false {
            peerTitles = ["Not paired"]
        } else if let peers = status.peers {
            peerTitles = peers.isEmpty
                ? ["No peers configured"]
                : peers.map { "\($0.label): \($0.connected && status.provider == .running ? "Connected" : "Disconnected")" }
        } else if managed?.paired == true && (status.provider == .disconnected || status.provider == .failed) {
            peerTitles = ["Paired with receiver — ready to connect"]
        } else if managed != nil {
            peerTitles = ["Peer status unavailable"]
        } else {
            peerTitles = []
        }

        let stopped = status.provider == .disconnected || status.provider == .failed
        canConnect = stopped && !busy && managed?.paired == true
        canDisconnect = !busy && (status.provider == .running || status.provider == .connecting)
        canPair = stopped && !busy && managed != nil
        canRetrySetup = stopped && !busy && managed == nil
        canCopyPublicKey = !busy && managed != nil
    }
}
