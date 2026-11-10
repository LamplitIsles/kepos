import Foundation
import NetworkExtension

@main struct StatusRefreshTest {
    @MainActor static func main() async {
        func require(_ value: @autoclosure () -> Bool, _ message: String) {
            if !value() { print("FAIL: \(message)"); exit(1) }
        }
        func reply(_ connected: Bool) -> Data {
            Data(("{\"running\":true,\"peers\":[{\"publicKey\":\"" +
                  String(repeating: "a", count: 64) +
                  "\",\"label\":\"fixture\",\"connected\":\(connected)}]}").utf8)
        }
        func manager() -> NETunnelProviderManager {
            let value = NETunnelProviderManager()
            let proto = NETunnelProviderProtocol()
            proto.providerBundleIdentifier = "fixture.kepos.tunnel"
            proto.providerConfiguration = ["owner": "kepos-vpn-v1"]
            value.protocolConfiguration = proto
            value.isEnabled = true
            value.connection.status = .connected
            return value
        }
        func waitForCallback() async -> ((Data?) -> Void) {
            for _ in 0..<300 {
                if let callback = NEFixture.statusCallback { return callback }
                try! await Task.sleep(nanoseconds: 10_000_000)
            }
            print("FAIL: provider callback not requested"); exit(1)
        }
        func waitForGate() async { try! await Task.sleep(nanoseconds: 2_100_000_000) }

        let original = manager()
        NEFixture.managers = [original]
        NEFixture.statusReply = reply(true)
        let controller = VPNController()
        var observed: [VPNStatus] = []
        controller.onStatusChange = { observed.append($0) }
        NEFixture.holdStatus = true
        let first = Task { await controller.refresh() }
        let firstCallback = await waitForCallback()
        require(controller.status.provider == .running && controller.status.peers == nil, "unknown stays unknown")
        NEFixture.statusCallback = nil
        firstCallback(reply(true))
        await first.value
        require(controller.status.peers?.first?.connected == true, "initial connected peer")

        observed.removeAll()
        let before = NEFixture.statusCount
        await controller.refresh()
        require(observed.isEmpty && NEFixture.statusCount == before, "rate limit preserves status")

        await waitForGate()
        NEFixture.holdStatus = true
        observed.removeAll()
        let pending = Task { await controller.refresh() }
        let callback = await waitForCallback()
        require(controller.status.peers?.first?.connected == true &&
                !observed.contains(where: { $0.provider == .running && $0.peers == nil }),
                "same connected session must not flicker unavailable while awaiting a valid reply")
        let requestsDuring = NEFixture.statusCount
        await controller.refresh()
        require(NEFixture.statusCount == requestsDuring, "concurrent refresh does not issue a second request")
        try! await Task.sleep(nanoseconds: 100_000_000)
        require(controller.status.peers?.first?.connected == true, "connected peer remains known during delay")
        NEFixture.statusCallback = nil
        callback(reply(true))
        await pending.value
        require(controller.status.peers?.first?.connected == true, "connected peer remains known")

        // Repeat the original stable-session scenario, with normal successful replies.
        for _ in 0..<3 {
            await waitForGate()
            observed.removeAll()
            let repeatRefresh = Task { await controller.refresh() }
            let repeatCallback = await waitForCallback()
            require(controller.status.peers?.first?.connected == true &&
                    !observed.contains(where: { $0.provider == .running && $0.peers == nil }),
                    "stable peer remains known throughout refresh")
            try! await Task.sleep(nanoseconds: 100_000_000)
            require(controller.status.peers?.first?.connected == true, "connected peer remains known during delay")
            NEFixture.statusCallback = nil
            repeatCallback(reply(true))
            await repeatRefresh.value
            require(controller.status.peers?.first?.connected == true, "successful repeat reply")
        }

        await waitForGate()
        let changed = Task { await controller.refresh() }
        let changedCallback = await waitForCallback()
        NEFixture.statusCallback = nil
        changedCallback(reply(false))
        await changed.value
        require(controller.status.peers?.first?.connected == false, "changed peer arrives")

        await waitForGate()
        let failure = Task { await controller.refresh() }
        let failureCallback = await waitForCallback()
        NEFixture.statusCallback = nil
        failureCallback(nil)
        await failure.value
        require(controller.status.provider == .running && controller.status.peers == nil, "nil reply becomes unknown")

        await waitForGate()
        NEFixture.holdStatus = false
        NEFixture.statusReply = reply(true)
        await controller.refresh()
        require(controller.status.peers?.first?.connected == true, "valid reply restores known state")

        await waitForGate()
        NEFixture.holdStatus = true
        let invalid = Task { await controller.refresh() }
        let invalidCallback = await waitForCallback()
        NEFixture.statusCallback = nil
        invalidCallback(Data("invalid".utf8))
        await invalid.value
        require(controller.status.peers == nil, "invalid reply becomes unknown")

        await waitForGate()
        NEFixture.holdStatus = false
        await controller.refresh()
        require(controller.status.peers?.first?.connected == true, "known state before timeout")
        await waitForGate()
        NEFixture.throwStatus = true
        await controller.refresh()
        NEFixture.throwStatus = false
        require(controller.status.peers == nil, "send failure becomes unknown")
        await waitForGate()
        await controller.refresh()
        require(controller.status.peers?.first?.connected == true, "known state after send failure")
        await waitForGate()
        NEFixture.holdStatus = true
        let timeout = Task { await controller.refresh() }
        let late = await waitForCallback()
        await timeout.value
        require(controller.status.peers == nil, "timeout becomes unknown")
        NEFixture.statusCallback = nil
        late(reply(true))
        try! await Task.sleep(nanoseconds: 50_000_000)
        require(controller.status.peers == nil, "late callback ignored")

        await waitForGate()
        NEFixture.holdStatus = false
        await controller.refresh()
        require(controller.status.peers?.first?.connected == true, "known state before changed session")
        await waitForGate()
        NEFixture.holdStatus = true
        let stale = Task { await controller.refresh() }
        let staleCallback = await waitForCallback()
        original.connection.connectedDate = Date(timeIntervalSince1970: 2)
        NEFixture.statusCallback = nil
        staleCallback(reply(true))
        await stale.value
        require(controller.status.peers == nil, "changed session cannot accept old reply")

        await waitForGate()
        NEFixture.holdStatus = false
        await controller.refresh()
        require(controller.status.peers?.first?.connected == true, "known state before connection notification")
        await waitForGate()
        NEFixture.holdStatus = true
        let interrupted = Task { await controller.refresh() }
        let interruptedCallback = await waitForCallback()
        original.connection.status = .disconnected
        NotificationCenter.default.post(name: .NEVPNStatusDidChange, object: original.connection)
        for _ in 0..<30 {
            if controller.status.provider != .running { break }
            try! await Task.sleep(nanoseconds: 10_000_000)
        }
        require(controller.status.provider != .running && controller.status.peers == nil,
                "disconnect notification invalidates in-flight known state")
        original.connection.status = .connected
        original.connection.connectedDate = Date(timeIntervalSince1970: 3)
        NotificationCenter.default.post(name: .NEVPNStatusDidChange, object: original.connection)
        try! await Task.sleep(nanoseconds: 50_000_000)
        NEFixture.statusCallback = nil
        interruptedCallback(reply(true))
        await interrupted.value
        require(controller.status.peers == nil, "reply from disconnected session is not applied")

        await waitForGate()
        NEFixture.holdStatus = false
        await controller.refresh()
        require(controller.status.peers?.first?.connected == true, "known state before manager replacement")
        let replacement = manager()
        NEFixture.managers = [replacement]
        await controller.refresh()
        require(controller.status.peers == nil, "manager replacement cannot retain prior peer")

        original.connection.status = .disconnected
        replacement.connection.status = .disconnected
        await controller.refresh()
        require(controller.status.provider != .running && controller.status.peers == nil, "disconnect invalidates status")
        require(!NEFixture.events.contains("save") && !NEFixture.events.contains("start") &&
                !NEFixture.events.contains("stop"), "refresh has no VPN mutations")
        print("PASS: status refresh, changed peer, failures, timeout, stale session and disconnect")
    }
}
