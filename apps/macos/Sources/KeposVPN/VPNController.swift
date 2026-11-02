import AppKit
import Foundation
import NetworkExtension

private enum ControllerFailure: Error {
    case unavailable, ambiguousConfiguration
}

@MainActor
final class VPNController: VPNControlling {
    private(set) var status = VPNStatus(provider: .disconnected, peers: nil, error: nil) {
        didSet { onStatusChange?(status) }
    }
    var onStatusChange: ((VPNStatus) -> Void)?
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
    private var managedOperation = false

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

    private func checkExternalIdentity() throws {
        guard let group = Bundle.main.object(forInfoDictionaryKey: "KeposAppGroupID") as? String,
              let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else { throw ManagedVPNError.localState }
        let root = container.appendingPathComponent("Kepos", isDirectory: true).standardizedFileURL
        let peer = root.appendingPathComponent("peer", isDirectory: true)
        if let selected = UserDefaults.standard.string(forKey: "vpnIdentityPath"), !selected.isEmpty,
           URL(fileURLWithPath: selected, isDirectory: true).standardizedFileURL != peer { throw ManagedVPNError.externalIdentity }
    }

    func prepareManagedState() async throws -> ManagedState {
        try checkExternalIdentity()
        do {
            let target = try await managedManager()
            guard let session = target.connection as? NETunnelProviderSession else { throw ManagedVPNError.providerUnavailable }
            let reply: Data? = await withCheckedContinuation { continuation in
                let once = StatusReply { outcome in
                    if case .data(let data) = outcome { continuation.resume(returning: data) }
                    else { continuation.resume(returning: nil) }
                }
                DispatchQueue.global().asyncAfter(deadline: .now() + 10) { once.finish(.timeout) }
                do { try session.sendProviderMessage(ManagedStateMessage.prepare) { once.finish($0.map(StatusOutcome.data) ?? .nilReply) } }
                catch { once.finish(.sendError) }
            }
            guard let reply else { throw ManagedVPNError.providerUnavailable }
            return try ManagedStateMessage.parse(reply)
        } catch let error as ManagedVPNError { throw error }
        catch { throw ManagedVPNError.localState }
    }

    func connectManaged() async throws {
        guard !managedOperation else { throw ManagedVPNError.busy }
        managedOperation = true
        defer { managedOperation = false }
        await refresh()
        let state = try await prepareManagedState()
        guard state.paired else { throw ManagedVPNError.unpaired }
        guard status.provider == .disconnected || status.provider == .failed else { throw ManagedVPNError.busy }
        try await startManaged(invitation: nil)
        guard let target = manager else { throw ManagedVPNError.localState }
        let deadline = ProcessInfo.processInfo.systemUptime + 35
        var observedStart = false
        while ProcessInfo.processInfo.systemUptime < deadline {
            let current = target.connection.status
            if current == .connected { await refresh(); return }
            if current == .connecting || current == .reasserting { observedStart = true }
            if observedStart && (current == .disconnected || current == .invalid) {
                var failure: NSError?
                do { try await target.connection.fetchLastDisconnectError() }
                catch { failure = error as NSError }
                await refresh()
                throw managedProviderFailure(failure, pairing: false)
            }
            if Task.isCancelled { stopTunnel(target.connection); throw ManagedVPNError.localState }
            try? await Task.sleep(nanoseconds: 200_000_000)
        }
        stopTunnel(target.connection)
        throw ManagedVPNError.providerUnavailable
    }

    func pair(invitation: String) async throws -> ManagedState {
        guard !managedOperation else { throw ManagedVPNError.busy }
        managedOperation = true
        defer { managedOperation = false }
        await refresh()
        guard status.provider == .disconnected || status.provider == .failed else { throw ManagedVPNError.busy }
        let original = try await prepareManagedState()
        let parts = invitation.split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count == 3, parts[0] == "kepos1", parts[1].utf8.count == 64, parts[2].utf8.count == 64,
              parts[1].utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }),
              parts[2].utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else { throw ManagedVPNError.unusableInvitation }
        try await startManaged(invitation: invitation)
        guard let target = manager else { throw ManagedVPNError.outcomeUnknown }
        var observedStart = false
        let deadline = ProcessInfo.processInfo.systemUptime + 35
        var result: ManagedState?
        while ProcessInfo.processInfo.systemUptime < deadline {
            if Task.isCancelled {
                stopTunnel(target.connection)
                throw ManagedVPNError.outcomeUnknown
            }
            let current = target.connection.status
            if current == .connecting || current == .reasserting || current == .connected { observedStart = true }
            if current == .connected, let session = target.connection as? NETunnelProviderSession {
                let reply: Data? = await withCheckedContinuation { continuation in
                    let once = StatusReply { outcome in
                        if case .data(let data) = outcome { continuation.resume(returning: data) }
                        else { continuation.resume(returning: nil) }
                    }
                    DispatchQueue.global().asyncAfter(deadline: .now() + 2) { once.finish(.timeout) }
                    do { try session.sendProviderMessage(Data([0])) { once.finish($0.map(StatusOutcome.data) ?? .nilReply) } }
                    catch { once.finish(.sendError) }
                }
                if let reply, reply.count <= 32_768,
                   let object = (try? JSONSerialization.jsonObject(with: reply)) as? [String: Any],
                   let pairing = object["pairing"], let data = try? JSONSerialization.data(withJSONObject: pairing),
                   let parsed = try? ManagedStateMessage.parse(data) { result = parsed }
                break
            }
            if observedStart && (current == .disconnected || current == .invalid) {
                var error: NSError?
                do { try await target.connection.fetchLastDisconnectError() }
                catch let failure { error = failure as NSError }
                await refresh()
                throw managedProviderFailure(error, pairing: true)
            }
            try? await Task.sleep(nanoseconds: 200_000_000)
        }
        stopTunnel(target.connection)
        let stopDeadline = ProcessInfo.processInfo.systemUptime + 5
        while target.connection.status != .disconnected && target.connection.status != .invalid && ProcessInfo.processInfo.systemUptime < stopDeadline {
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        await refresh()
        guard let result, result.paired, result.publicKey == original.publicKey,
              target.connection.status == .disconnected || target.connection.status == .invalid else { throw ManagedVPNError.outcomeUnknown }
        return result
    }

    private func startManaged(invitation: String?) async throws {
        refreshGeneration += 1
        lifecycle.prepareStart()
        do {
            status = VPNStatus(provider: .connecting, peers: nil, error: nil)
            let target = try await managedManager()
            var options: [String: NSObject] = ["operation": (invitation == nil ? "connect" : "pair") as NSString]
            if let invitation { options["invitation"] = invitation as NSString }
            try target.connection.startVPNTunnel(options: options)
            lifecycle.startSubmitted(at: ProcessInfo.processInfo.systemUptime)
        } catch {
            refreshGeneration += 1
            lifecycle.startFailed()
            status = lifecycle.observe(.disconnected, at: ProcessInfo.processInfo.systemUptime)
            if let safe = error as? ManagedVPNError { throw safe }
            throw ManagedVPNError.localState
        }
    }

    private func managedManager() async throws -> NETunnelProviderManager {
        guard let identifier = providerIdentifier, !identifier.isEmpty,
              let target = try await ownedManager(create: true) else { throw ManagedVPNError.localState }
        if target.protocolConfiguration == nil {
            let proto = NETunnelProviderProtocol()
            proto.providerBundleIdentifier = identifier
            proto.serverAddress = "Kepos"
            proto.providerConfiguration = ["owner": marker]
            target.protocolConfiguration = proto
            target.localizedDescription = "Kepos VPN"
            target.isEnabled = true
            try await target.saveToPreferences()
            try await target.loadFromPreferences()
        }
        manager = target
        return target
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

    func disconnect() async throws {
        guard let manager else { await refresh(); return }
        stopTunnel(manager.connection)
    }

    private func stopTunnel(_ connection: NEVPNConnection) {
        refreshGeneration += 1
        status = VPNStatus(provider: .disconnecting, peers: nil, error: nil)
        lifecycle.stop { connection.stopVPNTunnel() }
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
