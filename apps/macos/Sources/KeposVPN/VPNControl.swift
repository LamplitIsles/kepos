import Foundation

/// The system tunnel's state is separate from authenticated peer connectivity.
enum VPNProviderState: Equatable {
    case disconnected
    case connecting
    case running
    case disconnecting
    case failed
}

struct VPNPeerStatus: Equatable {
    let publicKey: String
    let label: String
    let connected: Bool
}

struct VPNStatus: Equatable {
    let provider: VPNProviderState
    /// Nil means peer status is unavailable, not that no peers are connected.
    let peers: [VPNPeerStatus]?
    let error: String?
}

/// The menu owns file selection and presentation; the controller owns VPN
/// configuration, identity access, permissions, and the provider lifecycle.
@MainActor
protocol VPNControlling: AnyObject {
    var status: VPNStatus { get }
    var onStatusChange: ((VPNStatus) -> Void)? { get set }

    func refresh() async
    func prepareIdentity(stateDirectory: URL) async throws -> String
    /// Read and validate an existing identity without creating or replacing it.
    func getExistingIdentityPublicKey(stateDirectory: URL) async throws -> String
    func connect(configURL: URL, stateDirectory: URL) async throws
    func disconnect() async throws
}
