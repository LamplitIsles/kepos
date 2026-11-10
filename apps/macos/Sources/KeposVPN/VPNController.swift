import Foundation
import NetworkExtension

private enum ControllerFailure: Error {
    case unavailable, ambiguousConfiguration
}

@MainActor
final class VPNController: VPNControlling {
    private(set) var status = VPNStatus(provider: .disconnected, peers: nil, error: nil) {
        didSet {
            if status.peers == nil {
                peerManager = nil
                peerConnection = nil
                peerConnectedDate = nil
            }
            onStatusChange?(status)
        }
    }
    var onStatusChange: ((VPNStatus) -> Void)?
    #if KEPOS_STATUS_DIAGNOSTICS
    private let statusDiagnostics = StatusDiagnostics.systemLogger(.host)
    #endif
    private let connectionMonitor = ConnectionMonitor(name: .NEVPNStatusDidChange)
    private weak var peerManager: NETunnelProviderManager?
    private weak var peerConnection: NEVPNConnection?
    private var peerConnectedDate: Date?
    private var manager: NETunnelProviderManager? {
        didSet {
            if oldValue !== manager {
                refreshGeneration += 1
                if status.peers != nil {
                    status = VPNStatus(provider: status.provider, peers: nil, error: status.error)
                }
            }
            guard oldValue?.connection !== manager?.connection else { return }
            let connection = manager?.connection
            lastObservedConnectionStatus = connection?.status
            connectionMonitor.observe(connection) { [weak self, weak connection] in
                Task { @MainActor in
                    guard let self, let connection, self.manager?.connection === connection else { return }
                    let observed = connection.status
                    guard self.lastObservedConnectionStatus != observed else { return }
                    self.lastObservedConnectionStatus = observed
                    self.refreshGeneration += 1
                    self.status = self.lifecycle.observe(self.providerState(observed), at: ProcessInfo.processInfo.systemUptime)
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
        #if os(macOS)
        guard let group = Bundle.main.object(forInfoDictionaryKey: "KeposAppGroupID") as? String,
              let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else { throw ManagedVPNError.localState }
        let root = container.appendingPathComponent("Kepos", isDirectory: true).standardizedFileURL
        let peer = root.appendingPathComponent("peer", isDirectory: true)
        if let selected = UserDefaults.standard.string(forKey: "vpnIdentityPath"), !selected.isEmpty,
           URL(fileURLWithPath: selected, isDirectory: true).standardizedFileURL != peer { throw ManagedVPNError.externalIdentity }
        #endif
    }

    func loadManagedState() async throws -> ManagedState? {
        guard !managedOperation else { throw ManagedVPNError.busy }
        managedOperation = true
        defer { managedOperation = false }
        try checkExternalIdentity()
        do {
            guard let target = try await managedManager(activate: false) else { return nil }
            return try await readManagedState(from: target)
        } catch let error as ManagedVPNError { throw error }
        catch { throw ManagedVPNError.localState }
    }

    func prepareManagedState() async throws -> ManagedState {
        guard !managedOperation else { throw ManagedVPNError.busy }
        managedOperation = true
        defer { managedOperation = false }
        return try await prepareManagedStateForOperation()
    }

    private func prepareManagedStateForOperation() async throws -> ManagedState {
        try checkExternalIdentity()
        do {
            guard let target = try await managedManager(activate: true) else { throw ManagedVPNError.providerUnavailable }
            return try await readManagedState(from: target)
        } catch let error as ManagedVPNError { throw error }
        catch { throw ManagedVPNError.localState }
    }

    private func readManagedState(from target: NETunnelProviderManager) async throws -> ManagedState {
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
    }

    func connectManaged() async throws {
        guard !managedOperation else { throw ManagedVPNError.busy }
        managedOperation = true
        defer { managedOperation = false }
        await refresh()
        let state = try await prepareManagedStateForOperation()
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
        let original = try await prepareManagedStateForOperation()
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
            guard let target = try await managedManager(activate: true) else { throw ManagedVPNError.providerUnavailable }
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

    private func managedManager(activate: Bool) async throws -> NETunnelProviderManager? {
        guard let identifier = providerIdentifier, !identifier.isEmpty else { throw ManagedVPNError.localState }
        let existing = try await ownedManager()
        guard activate || existing != nil else { return nil }
        let target = existing ?? NETunnelProviderManager()
        do { try await target.loadFromPreferences() }
        catch { throw ManagedVPNError.providerUnavailable }
        if existing == nil {
            guard target.protocolConfiguration == nil else { throw ManagedVPNError.localState }
            let proto = NETunnelProviderProtocol()
            proto.providerBundleIdentifier = identifier
            proto.serverAddress = "Kepos"
            proto.providerConfiguration = ["owner": marker]
            target.protocolConfiguration = proto
            target.localizedDescription = "Kepos VPN"
        } else {
            try validateOwned(target, identifier: identifier)
        }
        if activate && (existing == nil || !target.isEnabled) {
            target.isEnabled = true
            do {
                try await target.saveToPreferences()
                try await target.loadFromPreferences()
            } catch { throw ManagedVPNError.providerUnavailable }
            try validateOwned(target, identifier: identifier)
            guard target.isEnabled else { throw ManagedVPNError.providerUnavailable }
        }
        manager = target
        return target.isEnabled ? target : nil
    }

    private func validateOwned(_ target: NETunnelProviderManager, identifier: String) throws {
        guard let proto = target.protocolConfiguration as? NETunnelProviderProtocol,
              proto.providerBundleIdentifier == identifier,
              proto.providerConfiguration?["owner"] as? String == marker else {
            throw ManagedVPNError.localState
        }
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
        var generation = refreshGeneration
        do {
            let found = try await managerForRefresh(cached: manager, reloadPreferences: reloadPreferences) {
                try await ownedManager()
            }
            guard generation == refreshGeneration else { return }
            manager = found
            generation = refreshGeneration
            guard let found else {
                status = lifecycle.observe(.disconnected, at: ProcessInfo.processInfo.systemUptime)
                return
            }
            let observed = found.connection.status
            lastObservedConnectionStatus = observed
            let next = lifecycle.observe(providerState(observed), at: ProcessInfo.processInfo.systemUptime)
            let provider = next.provider
            let connectedAt = found.connection.connectedDate
            let sameSession = provider == .running && connectedAt != nil &&
                peerManager === found && peerConnection === found.connection &&
                peerConnectedDate == connectedAt && status.provider == .running
            if !sameSession { status = next }
            if provider == .running && !statusRequestGate.allow(at: ProcessInfo.processInfo.systemUptime) {
                return
            }
            guard provider == .running else { return }
            #if KEPOS_STATUS_DIAGNOSTICS
            let cycle = statusDiagnostics.begin()
            statusDiagnostics.record(cycle, .request)
            #endif
            guard let connectedAt, let session = found.connection as? NETunnelProviderSession else {
                #if KEPOS_STATUS_DIAGNOSTICS
                statusDiagnostics.record(cycle, .sessionMissing)
                #endif
                status = next
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
            guard manager === found, found.connection === session,
                  found.connection.status == .connected,
                  found.connection.connectedDate == connectedAt else {
                #if KEPOS_STATUS_DIAGNOSTICS
                statusDiagnostics.record(cycle, .connectionChanged)
                #endif
                status = lifecycle.observe(providerState(found.connection.status), at: ProcessInfo.processInfo.systemUptime)
                return
            }
            guard case .data(let data) = outcome else { status = next; return }
            guard let peers = ProviderStatus.peers(from: data) else {
                #if KEPOS_STATUS_DIAGNOSTICS
                statusDiagnostics.record(cycle, .decodeRejected)
                #endif
                status = next
                return
            }
            #if KEPOS_STATUS_DIAGNOSTICS
            statusDiagnostics.record(cycle, .decoded)
            #endif
            peerManager = found
            peerConnection = found.connection
            peerConnectedDate = connectedAt
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

    private func ownedManager() async throws -> NETunnelProviderManager? {
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
        return nil
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
