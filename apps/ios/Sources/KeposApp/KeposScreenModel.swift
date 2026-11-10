import Foundation
import Observation

/// Presentation state only. The provider owns the identity, configuration and VPN.
@Observable @MainActor
final class KeposScreenModel {
    @ObservationIgnored private let controller: any VPNControlling
    private(set) var status: VPNStatus
    private(set) var managed: ManagedState?
    private(set) var publicKey: String?
    private(set) var busy = false
    private(set) var actionError: String?
    private(set) var pairingWarning: String?

    init(controller: any VPNControlling) {
        self.controller = controller
        self.status = controller.status
        controller.onStatusChange = { [weak self] status in self?.status = status }
    }

    var stopped: Bool { status.provider == .disconnected || status.provider == .failed }
    var canPair: Bool { !busy && stopped && managed?.paired == false && pairingWarning == nil }
    var canConnect: Bool { !busy && stopped && managed?.paired == true }
    var canDisconnect: Bool { !busy && (status.provider == .running || status.provider == .connecting) }
    var canPrepare: Bool { !busy && status.provider != .connecting && status.provider != .disconnecting && managed == nil }
    var displayError: String? {
        if let actionError { return actionError }
        if status.provider == .failed {
            return "VPN stopped or could not connect. Check your network and configuration, then reconnect."
        }
        return nil
    }

    func load() async {
        guard canPrepare else { return }
        busy = true
        actionError = nil
        defer { busy = false }
        await controller.refresh()
        do {
            managed = try await controller.loadManagedState()
            if let managed { publicKey = managed.publicKey }
        } catch { actionError = Self.message(for: error as? ManagedVPNError) }
    }

    func prepare() async {
        guard canPrepare else { return }
        busy = true
        actionError = nil
        defer { busy = false }
        await controller.refresh()
        do {
            let state = try await controller.prepareManagedState()
            managed = state
            publicKey = state.publicKey
        } catch { actionError = Self.message(for: error as? ManagedVPNError) }
    }

    func refresh() async {
        guard !busy else { return }
        await controller.refresh()
    }

    func pair(invitation: String) async {
        guard canPair else { return }
        let invitation = invitation.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !invitation.isEmpty else {
            actionError = "Enter an invitation code."
            return
        }
        busy = true
        actionError = nil
        defer { busy = false }
        do {
            let state = try await controller.pair(invitation: invitation)
            managed = state
            publicKey = state.publicKey
            pairingWarning = nil
        } catch {
            let failure = error as? ManagedVPNError
            if failure == nil || failure == .outcomeUnknown || failure == .pairingConflictUnknown {
                managed = nil
                pairingWarning = "Pairing may have succeeded. Ask the receiver operator to check authorized devices using your public key before trying another invitation."
            } else {
                actionError = Self.message(for: failure)
            }
        }
    }

    func connect() async {
        guard canConnect else { return }
        await perform { try await controller.connectManaged() }
    }

    func disconnect() async {
        guard canDisconnect else { return }
        await perform { try await controller.disconnect() }
    }

    func dismissPairingWarning() { pairingWarning = nil }

    private func perform(_ action: () async throws -> Void) async {
        busy = true
        actionError = nil
        defer { busy = false }
        do { try await action() }
        catch { actionError = Self.message(for: error as? ManagedVPNError) }
    }

    /// OS and transport error strings can contain secrets; present fixed text only.
    private static func message(for error: ManagedVPNError?) -> String {
        switch error {
        case .unusableInvitation: return "The invitation is invalid, expired, or already used. Ask for a new one."
        case .receiverUnavailable: return "The receiver could not be reached. Check your network and try again."
        case .localState: return "Kepos could not access its identity or configuration. Check its storage and try again."
        case .permission: return "Allow Kepos to use VPN in iPhone Settings, then try again."
        case .externalIdentity: return "An existing identity is outside the managed location. It has been preserved and needs separate migration."
        case .unpaired: return "Pair this iPhone with a receiver before connecting."
        case .busy: return "Disconnect the VPN and wait for the current operation to finish."
        case .outcomeUnknown, .pairingConflictUnknown: return "Pairing may have succeeded. Ask the receiver operator to inspect authorized devices."
        case .providerUnavailable: return "Kepos could not access its VPN. Check that Kepos is selected and allowed in iPhone VPN settings, then try again."
        case .identityInUse: return "The identity is already in use. Wait for the other Kepos operation to finish."
        case .receiverCapacity: return "The receiver has no free device or address slots. Ask its operator to review capacity."
        case .receiverRouteConflict: return "A route conflicts with the receiver's address pool. Ask the receiver operator to check it."
        case .localAddressConflict: return "The assigned address is already in use on this iPhone. Ask the receiver operator for another address."
        case .routeInspectionUnavailable: return "Kepos could not inspect network addresses and routes. Check permissions and try again."
        case .receiverExcludedAddress: return "This device still has the excluded address. Ask the receiver operator to inspect its authorization."
        case nil: return "Kepos could not complete the operation. Check its permissions and try again."
        }
    }
}
