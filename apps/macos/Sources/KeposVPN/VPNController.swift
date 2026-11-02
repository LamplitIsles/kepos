import AppKit
import Foundation
import NetworkExtension
import SystemExtensions

private enum ControllerFailure: Error {
    case unavailable, ambiguousConfiguration, activation, configuration
}

private final class ExtensionActivation: NSObject, OSSystemExtensionRequestDelegate {
    private var completion: ((Bool) -> Void)?
    private var identifier: String?

    func activate(identifier: String) async throws {
        let success = await withCheckedContinuation { continuation in
            self.identifier = identifier
            completion = { continuation.resume(returning: $0) }
            let request = OSSystemExtensionRequest.activationRequest(forExtensionWithIdentifier: identifier, queue: .main)
            request.delegate = self
            OSSystemExtensionManager.shared.submitRequest(request)
        }
        if !success { throw ControllerFailure.activation }
    }

    func request(_ request: OSSystemExtensionRequest, actionForReplacingExtension existing: OSSystemExtensionProperties,
                 withExtension ext: OSSystemExtensionProperties) -> OSSystemExtensionRequest.ReplacementAction {
        mayReplaceExtension(expected: identifier, request: request.identifier,
                            existing: existing.bundleIdentifier, incoming: ext.bundleIdentifier) ? .replace : .cancel
    }
    func requestNeedsUserApproval(_ request: OSSystemExtensionRequest) {}
    func request(_ request: OSSystemExtensionRequest, didFailWithError error: Error) { finish(false) }
    func request(_ request: OSSystemExtensionRequest, didFinishWithResult result: OSSystemExtensionRequest.Result) {
        finish(result == .completed)
    }
    private func finish(_ success: Bool) { let callback = completion; completion = nil; identifier = nil; callback?(success) }
}

@MainActor
final class VPNController: VPNControlling {
    private(set) var status = VPNStatus(provider: .disconnected, peers: nil, error: nil) {
        didSet { onStatusChange?(status) }
    }
    var onStatusChange: ((VPNStatus) -> Void)?
    private let identity = IdentityStore()
    private let activation = ExtensionActivation()
    #if KEPOS_STATUS_DIAGNOSTICS
    private let statusDiagnostics = StatusDiagnostics.systemLogger(.host)
    #endif
    private let connectionMonitor = ConnectionMonitor(name: .NEVPNStatusDidChange)
    private var manager: NETunnelProviderManager? {
        didSet {
            guard oldValue?.connection !== manager?.connection else { return }
            let connection = manager?.connection
            lastObservedConnectionStatus = connection?.status
            connectionMonitor.observe(connection) { [weak self, weak connection] in
                Task { @MainActor in
                    guard let self, let connection, self.manager?.connection === connection else { return }
                    let observed = connection.status
                    guard self.lastObservedConnectionStatus != observed else { return }
                    self.lastObservedConnectionStatus = observed
                    await self.refresh(reloadPreferences: false)
                }
            }
        }
    }
    private var statusTimer: Timer?
    private var refreshGeneration = 0
    private var refreshing = false
    private var refreshAgain = false
    private var refreshAgainReloadPreferences = false
    private var lastObservedConnectionStatus: NEVPNStatus?
    private var lifecycle = TunnelLifecycle()
    private var statusRequestGate = StatusRequestGate()
    private let marker = "kepos-vpn-v1"

    private var providerIdentifier: String? {
        Bundle.main.object(forInfoDictionaryKey: "KeposProviderBundleID") as? String
    }

    init() {
        let timer = Timer(timeInterval: 2, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.status.provider == .running || self.status.provider == .connecting ||
                        self.status.provider == .disconnecting else { return }
                await self.refresh(reloadPreferences: false)
            }
        }
        RunLoop.main.add(timer, forMode: .common)
        statusTimer = timer
    }

    deinit {
        statusTimer?.invalidate()
    }

    func prepareIdentity(stateDirectory: URL) async throws -> String {
        do { return try identity.prepare(at: stateDirectory.standardizedFileURL) }
        catch { throw ControllerFailure.configuration }
    }

    func getExistingIdentityPublicKey(stateDirectory: URL) async throws -> String {
        do { return try identity.existingPublicKey(at: stateDirectory.standardizedFileURL) }
        catch { throw ControllerFailure.configuration }
    }

    func refresh() async { await refresh(reloadPreferences: true) }

    private func refresh(reloadPreferences: Bool) async {
        guard !refreshing else {
            refreshAgain = true
            refreshAgainReloadPreferences = refreshAgainReloadPreferences || reloadPreferences
            return
        }
        refreshing = true
        defer {
            refreshing = false
            if refreshAgain {
                refreshAgain = false
                let reload = refreshAgainReloadPreferences
                refreshAgainReloadPreferences = false
                Task { @MainActor [weak self] in await self?.refresh(reloadPreferences: reload) }
            }
        }
        refreshGeneration += 1
        let generation = refreshGeneration
        do {
            let found = try await managerForRefresh(cached: manager, reloadPreferences: reloadPreferences) {
                try await ownedManager(create: false)
            }
            guard generation == refreshGeneration else { return }
            manager = found
            guard let found else {
                status = lifecycle.observe(.disconnected, at: ProcessInfo.processInfo.systemUptime)
                return
            }
            let observed = found.connection.status
            lastObservedConnectionStatus = observed
            let next = lifecycle.observe(providerState(observed), at: ProcessInfo.processInfo.systemUptime)
            let provider = next.provider
            if provider == .running && !statusRequestGate.allow(at: ProcessInfo.processInfo.systemUptime) {
                if status.provider != .running {
                    status = VPNStatus(provider: .running, peers: nil, error: nil)
                }
                return
            }
            status = next
            guard provider == .running else { return }
            #if KEPOS_STATUS_DIAGNOSTICS
            let cycle = statusDiagnostics.begin()
            statusDiagnostics.record(cycle, .request)
            #endif
            guard let session = found.connection as? NETunnelProviderSession else {
                #if KEPOS_STATUS_DIAGNOSTICS
                statusDiagnostics.record(cycle, .sessionMissing)
                #endif
                return
            }
            #if KEPOS_STATUS_DIAGNOSTICS
            statusDiagnostics.record(cycle, .sessionReady)
            #endif
            let outcome: StatusOutcome = await withCheckedContinuation { continuation in
                let reply = StatusReply { continuation.resume(returning: $0) }
                DispatchQueue.global().asyncAfter(deadline: .now() + 2) { reply.finish(.timeout) }
                do { try session.sendProviderMessage(Data([0])) { reply.finish($0.map(StatusOutcome.data) ?? .nilReply) } }
                catch { reply.finish(.sendError) }
            }
            #if KEPOS_STATUS_DIAGNOSTICS
            switch outcome {
            case .data: statusDiagnostics.record(cycle, .replyData)
            case .nilReply: statusDiagnostics.record(cycle, .replyNil)
            case .timeout: statusDiagnostics.record(cycle, .timeout)
            case .sendError: statusDiagnostics.record(cycle, .sendError)
            }
            statusDiagnostics.record(cycle, generation == refreshGeneration ? .generationCurrent : .generationStale)
            #endif
            guard generation == refreshGeneration else { return }
            guard found.connection.status == .connected else {
                #if KEPOS_STATUS_DIAGNOSTICS
                statusDiagnostics.record(cycle, .connectionChanged)
                #endif
                return
            }
            guard case .data(let data) = outcome else { return }
            guard let peers = ProviderStatus.peers(from: data) else {
                #if KEPOS_STATUS_DIAGNOSTICS
                statusDiagnostics.record(cycle, .decodeRejected)
                #endif
                return
            }
            #if KEPOS_STATUS_DIAGNOSTICS
            statusDiagnostics.record(cycle, .decoded)
            #endif
            status = VPNStatus(provider: .running, peers: peers, error: nil)
        } catch {
            guard generation == refreshGeneration else { return }
            status = VPNStatus(provider: .failed, peers: nil, error: "VPN status unavailable")
        }
    }

    func connect(configURL: URL, stateDirectory: URL) async throws {
        refreshGeneration += 1
        lifecycle.prepareStart()
        do {
            guard let identifier = providerIdentifier, !identifier.isEmpty else { throw ControllerFailure.unavailable }
            let directory = stateDirectory.standardizedFileURL
            _ = try identity.existingPublicKey(at: directory)
            try identity.prepareLock(at: directory)
            let data = try Data(contentsOf: configURL)
            guard data.count <= 24_000, let config = String(data: data, encoding: .utf8) else { throw ControllerFailure.configuration }
            status = VPNStatus(provider: .connecting, peers: nil, error: nil)
            try await activation.activate(identifier: identifier)
            guard let target = try await ownedManager(create: true) else { throw ControllerFailure.unavailable }
            let proto = NETunnelProviderProtocol()
            proto.providerBundleIdentifier = identifier
            proto.serverAddress = "Kepos"
            proto.providerConfiguration = ["owner": marker]
            target.protocolConfiguration = proto
            target.localizedDescription = "Kepos VPN"
            target.isEnabled = true
            try await target.saveToPreferences()
            try await target.loadFromPreferences()
            manager = target
            try target.connection.startVPNTunnel(options: ["config": config as NSString, "stateDirectory": directory.path as NSString])
            lifecycle.startSubmitted(at: ProcessInfo.processInfo.systemUptime)
        } catch {
            refreshGeneration += 1
            lifecycle.startFailed()
            status = lifecycle.observe(.disconnected, at: ProcessInfo.processInfo.systemUptime)
            throw ControllerFailure.configuration
        }
    }

    func disconnect() async throws {
        guard let manager else { await refresh(); return }
        refreshGeneration += 1
        lifecycle.requestStop()
        status = VPNStatus(provider: .disconnecting, peers: nil, error: nil)
        manager.connection.stopVPNTunnel()
    }

    private func ownedManager(create: Bool) async throws -> NETunnelProviderManager? {
        guard let identifier = providerIdentifier else { throw ControllerFailure.unavailable }
        let all = try await NETunnelProviderManager.loadAllFromPreferences()
        let matching = all.filter { ($0.protocolConfiguration as? NETunnelProviderProtocol)?.providerBundleIdentifier == identifier }
        guard matching.count <= 1 else { throw ControllerFailure.ambiguousConfiguration }
        if let found = matching.first {
            guard (found.protocolConfiguration as? NETunnelProviderProtocol)?.providerConfiguration?["owner"] as? String == marker else {
                throw ControllerFailure.ambiguousConfiguration
            }
            return found
        }
        return create ? NETunnelProviderManager() : nil
    }

    private func providerState(_ state: NEVPNStatus) -> VPNProviderState {
        switch state {
        case .invalid, .disconnected: return .disconnected
        case .connecting, .reasserting: return .connecting
        case .connected: return .running
        case .disconnecting: return .disconnecting
        @unknown default: return .failed
        }
    }
}
