import Foundation
import NetworkExtension
import Darwin

private typealias TunnelFailure = ProviderFailure

private struct WorkletPeer: Decodable {
    let publicKey: String
    let label: String
    let address: String
    let connected: Bool
}

private struct WorkletMessage: Decodable {
    let type: String
    let address: String?
    let peers: [WorkletPeer]?
    let publicKey: String?
    let connected: Bool?
    let receiverAddress: String?
    let receiverKey: String?
    let reason: String?
    #if KEPOS_ACCEPTANCE_DIAGNOSTICS
    let event: String?
    #endif
}

/// The user-context app extension owns identity, configuration, lock and worklet.
/// Mutable provider state is confined to `queue`.
final class PacketTunnelProvider: NEPacketTunnelProvider, @unchecked Sendable {
    private let queue = DispatchQueue(label: "kepos.packet-tunnel")
    #if KEPOS_ACCEPTANCE_DIAGNOSTICS
    private let acceptanceDiagnostics = AcceptanceDiagnostics.systemLogger()
    #endif
    #if KEPOS_STATUS_DIAGNOSTICS
    private let statusDiagnostics = StatusDiagnostics.systemLogger(.provider)
    #endif
    private var worklet: Worklet?
    private var ipc: IPC?
    private var workletTornDown = false
    private var shutdown = WorkletShutdown()
    private var decoder = WorkletFrames()
    private var lockFD: Int32 = -1
    private var outgoing = WorkletOutput()
    private var peers: [[String: Any]] = []
    private var running = false
    private var stopped = true
    private var stopping = false
    private var settingsRequested = false
    private var settingsApplied = false
    private var pairing = false
    private var pairResult: [String: Any]?
    private var publicKey: String?
    private var generation = 0
    private var startCompletion: ((Error?) -> Void)?
    private var stopCompletion: (() -> Void)?
    private var timeout: DispatchWorkItem?

    override func startTunnel(options: [String: NSObject]? = nil, completionHandler: @escaping (Error?) -> Void) {
        queue.async { [self] in
            guard self.stopped else { completionHandler(TunnelFailure.bridge); return }
            self.stopped = false
            self.generation += 1
            let generation = self.generation
            self.stopping = false
            self.workletTornDown = false
            self.shutdown = WorkletShutdown()
            self.settingsRequested = false
            self.settingsApplied = false
            self.pairing = false
            self.pairResult = nil
            self.startCompletion = completionHandler
            do {
                guard let operation = options?["operation"] as? String,
                      operation == "pair" || operation == "connect" else { throw TunnelFailure.configuration }
                let invitation = options?["invitation"] as? String
                guard (operation == "pair") == (invitation != nil),
                      (invitation?.utf8.count ?? 0) <= 256 else { throw TunnelFailure.configuration }
                self.pairing = invitation != nil
                guard let managed = try? self.managedPeer() else { throw TunnelFailure.identity }
                do { self.lockFD = try managed.acquireLock() }
                catch ManagedVPNError.identityInUse { throw TunnelFailure.identityInUse }
                catch { throw TunnelFailure.identity }
                let current: ManagedConfig?
                do { current = try managed.store.read() } catch { throw TunnelFailure.identity }
                if let invitation {
                    let parts = invitation.split(separator: ":", omittingEmptySubsequences: false)
                    guard parts.count == 3, parts[0] == "kepos1", parts[1].utf8.count == 64, parts[2].utf8.count == 64,
                          parts[1].utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }),
                          parts[2].utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else { throw TunnelFailure.invitation }
                    if let current, current.receiverKey != parts[1] { throw TunnelFailure.configuration }
                } else if current == nil { throw TunnelFailure.configuration }
                let identity = existingPeerIdentity()
                let seed: Data
                do {
                    seed = try identity.readSeed(stateDirectory: managed.directory)
                    let key = try identity.derivePublicKey(seed)
                    guard key.count == 32 else { throw TunnelFailure.identity }
                    self.publicKey = key.map { String(format: "%02x", $0) }.joined()
                } catch { throw TunnelFailure.identity }
                let seedHex = seed.map { String(format: "%02x", $0) }.joined()
                #if os(iOS)
                // Fail before sending a single-use invitation when the iOS
                // sandbox cannot inspect routes at all. Pairing validates the
                // assigned addresses again after the receiver replies.
                if invitation != nil {
                    do { _ = try localIPv4Snapshot() }
                    catch { throw TunnelFailure.routeInspectionBeforePair }
                }
                let workletResource = "ios-worklet"
                #else
                let workletResource = "macos-worklet"
                #endif
                guard let bundle = Bundle.main.path(forResource: workletResource, ofType: "bundle") else {
                    throw TunnelFailure.extensionUnavailable
                }
                let worklet = try Worklet()
                let ipc = try IPC(worklet: worklet)
                try worklet.start(bundle, arguments: [])
                self.worklet = worklet
                self.ipc = ipc
                Task { [weak self] in
                    let code = await worklet.wait()
                    guard let self else { return }
                    self.queue.async {
                        guard !self.stopped, self.generation == generation else { return }
                        // Bare Kit invokes its exit callback after runtime
                        // teardown, before the native thread finally returns.
                        self.workletTornDown = true
                        guard self.stopping else { self.fail(TunnelFailure.bridge); return }
                        self.completeStop(self.shutdown.exited(code))
                    }
                }
                self.readIPC()
                if let invitation { try self.sendControl(["type": "pair", "invitation": invitation, "seed": seedHex]) }
                else { try self.sendControl(["type": "start", "config": current!.tunnelConfig, "seed": seedHex]) }
                let timeout = DispatchWorkItem { [weak self] in
                    guard let self, self.generation == generation else { return }
                    self.fail(self.pairing ? TunnelFailure.pairingUnknown : TunnelFailure.timeout)
                }
                self.timeout = timeout
                self.queue.asyncAfter(deadline: .now() + 30, execute: timeout)
            } catch {
                self.fail(error)
            }
        }
    }

    override func stopTunnel(with reason: NEProviderStopReason, completionHandler: @escaping () -> Void) {
        queue.async { [self] in
            guard !self.stopped else { completionHandler(); return }
            self.stopCompletion = completionHandler
            self.stopping = true
            self.running = false
            self.outgoing.discardPackets()
            do { try self.sendControl(["type": "stop"]) }
            catch { self.fail(error); return }
            self.timeout?.cancel()
            let generation = self.generation
            let timeout = DispatchWorkItem { [weak self] in
                guard let self, self.generation == generation else { return }
                self.fail(TunnelFailure.timeout)
            }
            self.timeout = timeout
            self.queue.asyncAfter(deadline: .now() + 3, execute: timeout)
        }
    }

    override func handleAppMessage(_ messageData: Data, completionHandler: ((Data?) -> Void)? = nil) {
        #if KEPOS_STATUS_DIAGNOSTICS
        let cycle = statusDiagnostics.begin()
        statusDiagnostics.record(cycle, .handler)
        #endif
        queue.async {
            guard let completionHandler else {
                #if KEPOS_STATUS_DIAGNOSTICS
                self.statusDiagnostics.record(cycle, .handlerNoCompletion)
                #endif
                return
            }
            if messageData == ManagedStateMessage.prepare {
                do {
                    let state = try self.managedPeer().prepare(holdingLock: self.lockFD >= 0)
                    completionHandler(ManagedStateMessage.response(state))
                } catch let error as ManagedVPNError {
                    completionHandler(ManagedStateMessage.failure(error))
                } catch { completionHandler(ManagedStateMessage.failure(.localState)) }
                return
            }
            guard messageData == Data([0]) else { completionHandler(nil); return }
            #if KEPOS_STATUS_DIAGNOSTICS
            self.statusDiagnostics.record(cycle, self.running ? .providerRunning : .providerStopped)
            self.statusDiagnostics.record(cycle, .peerCount(self.peers.count))
            #endif
            var result: [String: Any] = ["running": self.running, "peers": self.peers]
            if let pairing = self.pairResult { result["pairing"] = pairing }
            let encoded = try? JSONSerialization.data(withJSONObject: result)
            #if KEPOS_STATUS_DIAGNOSTICS
            self.statusDiagnostics.record(cycle, encoded == nil ? .encodeFailed : .encoded)
            #endif
            completionHandler(encoded)
        }
    }

    private func managedPeer() throws -> ManagedPeerState {
        guard let group = Bundle.main.object(forInfoDictionaryKey: "KeposAppGroupID") as? String,
              let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else { throw ManagedVPNError.localState }
        let identity = IdentityStore()
        return ManagedPeerState(root: container.appendingPathComponent("Kepos", isDirectory: true),
                                existingKey: identity.existingPublicKey, createKey: identity.prepare)
    }

    private func readIPC() {
        guard !stopped, let ipc else { return }
        let generation = generation
        Task { [weak self] in
            let data = await ipc.makeAsyncIterator().next()
            guard let self else { return }
            self.queue.async {
                guard !self.stopped, self.generation == generation else { return }
                guard let data, !data.isEmpty else {
                    if self.stopping && self.shutdown.hasAcknowledged { return }
                    self.fail(TunnelFailure.bridge)
                    return
                }
                do {
                    // A stopped control frame can reset provider state during
                    // delivery; do not mutate the stored decoder in its callback.
                    var decoder = self.decoder
                    try decoder.append(data) { kind, payload in
                        guard !self.stopped else { throw TunnelFailure.bridge }
                        if kind == WorkletFrames.control { try self.receiveControl(payload) }
                        else if payload.count >= 20 && payload.count <= 1400 {
                            if self.running {
                                let written = self.packetFlow.writePackets([payload], withProtocols: [NSNumber(value: AF_INET)])
                                #if KEPOS_ACCEPTANCE_DIAGNOSTICS
                                self.acceptanceDiagnostics.packetFlowWrite(written)
                                #else
                                _ = written
                                #endif
                            } else if !self.stopping { throw TunnelFailure.bridge }
                        } else { throw TunnelFailure.bridge }
                    }
                    if !self.stopped { self.decoder = decoder }
                    self.readIPC()
                } catch { self.fail(error) }
            }
        }
    }

    private func receiveControl(_ payload: Data) throws {
        let value = try JSONDecoder().decode(WorkletMessage.self, from: payload)
        switch value.type {
        case "pair-error":
            guard pairing, !stopping else { throw TunnelFailure.bridge }
            switch value.reason {
            case "unusable": throw TunnelFailure.invitation
            case "unavailable": throw TunnelFailure.receiverUnavailable
            case "capacity": throw TunnelFailure.capacity
            case "pool": throw TunnelFailure.pool
            case "route": throw TunnelFailure.receiverRouteConflict
            case "excluded": throw TunnelFailure.excludedAddress
            default: throw TunnelFailure.pairingUnknown
            }
        case "paired":
            guard pairing, !stopping, !settingsRequested, let address = value.address, validAddress(address),
                  let receiverAddress = value.receiverAddress, validAddress(receiverAddress), receiverAddress != address,
                  let receiverKey = value.receiverKey, receiverKey.utf8.count == 64,
                  receiverKey.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else { throw TunnelFailure.pairingUnknown }
            try checkLocalRoutes(address: address, receivers: [receiverAddress], afterPairing: true)
            settingsRequested = true
            guard let config = ManagedConfig(value: ["address": address, "receiverAddress": receiverAddress, "receiverKey": receiverKey]),
                  let publicKey else { throw TunnelFailure.pairingUnknown }
            let settings = NEPacketTunnelNetworkSettings(tunnelRemoteAddress: "127.0.0.1")
            let ipv4 = NEIPv4Settings(addresses: [address], subnetMasks: ["255.255.255.255"])
            ipv4.includedRoutes = []
            settings.ipv4Settings = ipv4
            settings.mtu = 1400
            let generation = generation
            setTunnelNetworkSettings(settings) { [weak self] error in
                guard let self else { return }
                self.queue.async {
                    guard !self.stopped, !self.stopping, self.generation == generation else { return }
                    guard error == nil else { self.fail(TunnelFailure.pairingUnknown); return }
                    let state: ManagedState
                    do { state = try self.managedPeer().commitPair(config, publicKey: publicKey) }
                    catch { self.fail(TunnelFailure.pairingUnknown); return }
                    self.pairResult = ["publicKey": state.publicKey, "paired": state.paired]
                    self.settingsApplied = true
                    self.running = true
                    self.timeout?.cancel()
                    self.timeout = nil
                    let completion = self.startCompletion
                    self.startCompletion = nil
                    completion?(nil)
                }
            }
        #if KEPOS_ACCEPTANCE_DIAGNOSTICS
        case "acceptance-diagnostic":
            guard let event = value.event, acceptanceDiagnostics.worklet(event) else { throw TunnelFailure.bridge }
        #endif
        case "settings":
            guard !stopping, !settingsRequested, let address = value.address, validAddress(address),
                  let peers = value.peers, peers.count <= 16 else { throw TunnelFailure.bridge }
            settingsRequested = true
            var addresses: [String] = []
            var keys = Set<String>()
            for peer in peers {
                guard validAddress(peer.address), peer.address != address, !addresses.contains(peer.address),
                      peer.publicKey.utf8.count == 64,
                      peer.publicKey.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }),
                      keys.insert(peer.publicKey).inserted, !peer.connected,
                      !peer.label.isEmpty, peer.label.utf8.count <= 128,
                      !peer.label.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) else { throw TunnelFailure.bridge }
                addresses.append(peer.address)
                self.peers.append(["publicKey": peer.publicKey, "label": peer.label, "connected": false])
            }
            try checkLocalRoutes(address: address, receivers: addresses, afterPairing: false)
            let settings = NEPacketTunnelNetworkSettings(tunnelRemoteAddress: "127.0.0.1")
            let ipv4 = NEIPv4Settings(addresses: [address], subnetMasks: ["255.255.255.255"])
            ipv4.includedRoutes = vpnHostRoutes(addresses).map { NEIPv4Route(destinationAddress: $0.address, subnetMask: $0.mask) }
            settings.ipv4Settings = ipv4
            settings.mtu = 1400
            let generation = generation
            setTunnelNetworkSettings(settings) { [weak self] error in
                guard let self else { return }
                self.queue.async {
                    guard !self.stopped, !self.stopping, self.generation == generation else { return }
                    if error != nil { self.fail(TunnelFailure.settings); return }
                    self.settingsApplied = true
                    do { try self.sendControl(["type": "ready"]) }
                    catch { self.fail(error) }
                }
            }
        case "running":
            guard !stopping, settingsApplied, !running else { throw TunnelFailure.bridge }
            running = true
            timeout?.cancel()
            timeout = nil
            let completion = startCompletion
            startCompletion = nil
            completion?(nil)
            readPackets()
        case "peer":
            guard settingsRequested, let key = value.publicKey,
                  let connected = value.connected,
                  let index = peers.firstIndex(where: { $0["publicKey"] as? String == key }) else { throw TunnelFailure.bridge }
            if !stopping { peers[index]["connected"] = connected }
        case "stopped":
            guard stopping else { throw TunnelFailure.bridge }
            let decision = shutdown.acknowledge()
            ipc?.end()
            completeStop(decision)
        default: throw TunnelFailure.bridge
        }
    }

    private func validAddress(_ value: String) -> Bool {
        let parts = value.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4 else { return false }
        let bytes = parts.compactMap { UInt8($0) }
        guard bytes.count == 4, zip(parts, bytes).allSatisfy({ String($0.1) == $0.0 }) else { return false }
        return bytes[0] != 0 && bytes[0] != 127 && bytes[0] < 224 && !(bytes[0] == 169 && bytes[1] == 254)
    }

    private func checkLocalRoutes(address: String, receivers: [String], afterPairing: Bool) throws {
        let snapshot: LocalIPv4Snapshot
        do { snapshot = try localIPv4Snapshot() }
        catch { throw afterPairing ? TunnelFailure.pairingUnknown : TunnelFailure.routeInspectionUnavailable }
        guard let conflict = vpnRouteConflict(local: address, receivers: receivers, snapshot: snapshot) else { return }
        if afterPairing { throw TunnelFailure.pairingConflictUnknown }
        switch conflict {
        case .localAddress: throw TunnelFailure.localAddressConflict
        case .receiverAddress, .receiverHostRoute: throw TunnelFailure.receiverRouteConflict
        }
    }

    private func readPackets() {
        guard running, !stopped, outgoing.beginPacketRead() else { return }
        let generation = generation
        packetFlow.readPackets { [weak self] packets, protocols in
            guard let self else { return }
            self.queue.async {
                guard self.running, !self.stopped, self.generation == generation else { return }
                self.outgoing.finishPacketRead()
                do { try self.outgoing.enqueuePackets(packets, protocols: protocols, ipv4: Int(AF_INET)) }
                catch { self.fail(error); return }
                self.writeNext()
                if self.outgoing.isIdle { self.readPackets() }
            }
        }
    }

    private func sendControl(_ value: [String: Any]) throws {
        let payload = try JSONSerialization.data(withJSONObject: value)
        guard !stopped else { throw TunnelFailure.bridge }
        try outgoing.enqueueControl(payload)
        writeNext()
    }

    private func writeNext() {
        guard let ipc, let data = outgoing.next() else { return }
        let generation = generation
        Task { [weak self] in
            let failed: Bool
            do { try await ipc.write(data); failed = false }
            catch { failed = true }
            guard let self else { return }
            self.queue.async {
                guard !self.stopped, self.generation == generation else { return }
                self.outgoing.complete()
                if failed { self.fail(TunnelFailure.bridge); return }
                self.writeNext()
                if self.outgoing.isIdle { self.readPackets() }
            }
        }
    }

    private func completeStop(_ decision: WorkletShutdown.Decision) {
        switch decision {
        case .wait: break
        case .finish: finish()
        case .fail: fail(TunnelFailure.bridge)
        }
    }

    private func fail(_ error: Error) {
        guard !stopped else { return }
        let wasRunning = running
        let completion = startCompletion
        startCompletion = nil
        let safe = (error as? TunnelFailure ?? (pairing ? .pairingUnknown : .bridge)).safeError
        completion?(safe)
        if wasRunning { cancelTunnelWithError(safe) }
        if worklet != nil && !workletTornDown {
            // A missing exit callback must never release the identity lock
            // while worklet threads might still hold the identity.
            _exit(1)
        }
        finish()
    }

    private func finish() {
        guard !stopped else { return }
        stopped = true
        generation += 1
        running = false
        timeout?.cancel()
        timeout = nil
        ipc?.close()
        ipc = nil
        worklet?.terminate()
        worklet = nil
        outgoing = WorkletOutput()
        peers.removeAll()
        publicKey = nil
        decoder = WorkletFrames()
        if lockFD >= 0 { _ = flock(lockFD, LOCK_UN); _ = close(lockFD); lockFD = -1 }
        let start = startCompletion
        startCompletion = nil
        start?(TunnelFailure.bridge)
        let stop = stopCompletion
        stopCompletion = nil
        stop?()
    }
}
