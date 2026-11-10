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

/// A public identity and whether a receiver has been configured for it.
struct ManagedState: Equatable {
    let publicKey: String
    let paired: Bool
}

/// Only these fixed messages may be presented for managed operations. In
/// particular, underlying system and transport errors can contain secrets.
enum ManagedVPNError: Error, Equatable, LocalizedError {
    case unusableInvitation
    case receiverUnavailable
    case localState
    case permission
    case externalIdentity
    case unpaired
    case busy
    case outcomeUnknown
    case providerUnavailable
    case identityInUse
    case receiverCapacity
    case receiverRouteConflict
    case localAddressConflict
    case routeInspectionUnavailable
    case pairingConflictUnknown
    case receiverExcludedAddress

    var errorDescription: String? {
        switch self {
        case .unusableInvitation: return "This invitation is invalid, expired, or already used. Request a new invitation."
        case .receiverUnavailable: return "The receiver could not be reached. Check the network and try again."
        case .localState: return "Kepos cannot access or validate its local identity or configuration. Check its storage permissions and state."
        case .permission: return "Kepos needs permission to use the VPN. Check System Settings."
        case .externalIdentity: return "An existing identity is stored outside the managed location. It has been preserved; migration requires a separate operation."
        case .unpaired: return "Pair this device with a receiver before connecting."
        case .busy: return "Disconnect the VPN and wait for any current operation to finish."
        case .outcomeUnknown: return "Pairing could not be confirmed. Ask the receiver operator to inspect authorized devices before retrying."
        case .providerUnavailable: return "The VPN provider could not start. Check VPN permissions and try again."
        case .identityInUse: return "The device identity is already in use. Stop the other Kepos process and retry."
        case .receiverCapacity: return "The receiver has no device or address capacity. Ask its operator to review authorized devices and the address pool."
        case .receiverRouteConflict: return "A receiver or local host route conflicts with the VPN address. Ask the operator to check the receiver pool and local routes."
        case .localAddressConflict: return "The assigned device address is already in use on this Mac. Ask the receiver operator for a nonconflicting address."
        case .routeInspectionUnavailable: return "Kepos could not inspect local IPv4 addresses and routes. Check system permissions and retry."
        case .pairingConflictUnknown: return "The assigned address or receiver route conflicts with this Mac. Pairing may have succeeded; ask the receiver operator to inspect authorized devices before retrying."
        case .receiverExcludedAddress: return "This device still has the excluded address. Ask the receiver operator to inspect and revoke the device before re-admission."
        }
    }
}

enum ProviderFailure: Int, Error {
    case configuration = 1, identity, extensionUnavailable, bridge, settings, timeout
    case invitation, receiverUnavailable, pairingUnknown, permission, identityInUse
    case capacity, pool, receiverRouteConflict, localAddressConflict, routeInspectionUnavailable, pairingConflictUnknown
    case excludedAddress, routeInspectionBeforePair

    var safeError: NSError { NSError(domain: "io.lamplitisles.kepos.tunnel", code: rawValue) }
}

/// Only fixed provider codes are accepted; arbitrary OS error text is ignored.
func managedProviderFailure(_ error: NSError?, pairing: Bool) -> ManagedVPNError {
    guard error?.domain == "io.lamplitisles.kepos.tunnel", let code = error?.code,
          let failure = ProviderFailure(rawValue: code) else { return pairing ? .outcomeUnknown : .providerUnavailable }
    switch failure {
    case .configuration, .identity: return .localState
    case .permission: return .permission
    case .identityInUse: return .identityInUse
    case .extensionUnavailable: return .providerUnavailable
    case .invitation: return .unusableInvitation
    case .receiverUnavailable: return .receiverUnavailable
    case .capacity, .pool: return .receiverCapacity
    case .receiverRouteConflict: return .receiverRouteConflict
    case .localAddressConflict: return pairing ? .pairingConflictUnknown : .localAddressConflict
    case .routeInspectionUnavailable: return pairing ? .outcomeUnknown : .routeInspectionUnavailable
    case .routeInspectionBeforePair: return .routeInspectionUnavailable
    case .pairingConflictUnknown: return .pairingConflictUnknown
    case .excludedAddress: return .receiverExcludedAddress
    case .pairingUnknown, .bridge, .settings, .timeout: return pairing ? .outcomeUnknown : .providerUnavailable
    }
}

/// The menu owns presentation; the provider owns managed state and identity.
@MainActor
protocol VPNControlling: AnyObject {
    var status: VPNStatus { get }
    var onStatusChange: ((VPNStatus) -> Void)? { get set }

    func refresh() async
    /// Read an already enabled owned configuration, without enabling or creating one.
    /// Returns nil when the user needs to set up or select Kepos.
    func loadManagedState() async throws -> ManagedState?
    /// A user-initiated setup may enable the owned VPN configuration and launch
    /// the provider to read state, without starting a tunnel.
    /// Existing external identity must not be replaced.
    func prepareManagedState() async throws -> ManagedState
    /// Requires a disconnected provider. The UI treats this as an in-progress
    /// operation until it returns; cancellation cannot prove remote rollback.
    /// A temporary provider may transition through connecting/disconnecting.
    func pair(invitation: String) async throws -> ManagedState
    func connectManaged() async throws
    func disconnect() async throws
}
