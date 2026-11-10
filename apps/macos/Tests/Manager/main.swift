import Foundation
import NetworkExtension

func require(_ condition: @autoclosure () -> Bool, _ message: String) {
    if !condition() { fatalError(message) }
}

func ordered(_ wanted: [String], in events: [String]) -> Bool {
    var next = 0
    for event in events where next < wanted.count && event == wanted[next] { next += 1 }
    return next == wanted.count
}

@MainActor
func expectFailure(_ expected: ManagedVPNError, _ action: () async throws -> Void) async {
    do { try await action(); fatalError("expected \(expected)") }
    catch let error as ManagedVPNError { require(error == expected, "unexpected managed error") }
    catch { fatalError("unexpected error type") }
}

@MainActor
func configured(enabled: Bool, identifier: String = "fixture.kepos.tunnel", owner: String = "kepos-vpn-v1") -> NETunnelProviderManager {
    let manager = NETunnelProviderManager()
    let proto = NETunnelProviderProtocol()
    proto.providerBundleIdentifier = identifier
    proto.serverAddress = "preserved-server"
    proto.providerConfiguration = ["owner": owner, "keep": "preserved-value"]
    manager.protocolConfiguration = proto
    manager.localizedDescription = "preserved-description"
    manager.isEnabled = enabled
    return manager
}

@main
struct ManagerTest {
    @MainActor static func main() async throws {
        guard Bundle.main.object(forInfoDictionaryKey: "KeposProviderBundleID") as? String == "fixture.kepos.tunnel" else {
            fatalError("test bundle metadata missing")
        }

        NEFixture.reset()
        let noManager = VPNController()
        let missing = try await noManager.loadManagedState()
        await noManager.refresh()
        require(missing == nil && NEFixture.managers.isEmpty, "passive missing manager created a configuration")
        require(!NEFixture.events.contains("save") && !NEFixture.events.contains("send:1"), "passive missing manager wrote or sent")

        NEFixture.reset()
        let owned = configured(enabled: false)
        let other = configured(enabled: true, identifier: "fixture.other.tunnel", owner: "other")
        NEFixture.managers = [owned, other]
        NEFixture.events = []
        let controller = VPNController()
        let disabled = try await controller.loadManagedState()
        await controller.refresh()
        require(disabled == nil && !owned.isEnabled && other.isEnabled, "passive disabled manager changed selection")
        require(!NEFixture.events.contains("save") && !NEFixture.events.contains("send:1"), "passive disabled manager wrote or sent")

        NEFixture.events = []
        let state = try await controller.prepareManagedState()
        require(!state.paired && state.publicKey == String(repeating: "ab", count: 32), "explicit setup did not return public state")
        require(ordered(["loadAll", "load", "enabled:true", "save", "load", "send:1"], in: NEFixture.events), "setup did not load, enable, save, reload, then prepare")
        require(!NEFixture.events.contains("start") && !NEFixture.events.contains("invitation"), "setup started a tunnel or submitted an invitation")
        let proto = owned.protocolConfiguration as! NETunnelProviderProtocol
        require(other.isEnabled && proto.serverAddress == "preserved-server" && proto.providerConfiguration?["keep"] as? String == "preserved-value" && owned.localizedDescription == "preserved-description", "setup changed unrelated configuration")

        NEFixture.events = []
        let loaded = try await controller.loadManagedState()
        require(loaded == state && NEFixture.events.contains("send:1"), "passive enabled manager did not load state")
        require(!NEFixture.events.contains("save") && !NEFixture.events.contains("enabled:true"), "passive enabled manager wrote preferences")

        NEFixture.reset()
        let created = VPNController()
        _ = try await created.prepareManagedState()
        require(NEFixture.managers.count == 1 && ordered(["loadAll", "load", "enabled:true", "save", "load", "send:1"], in: NEFixture.events), "explicit setup did not create and enable manager")

        NEFixture.reset()
        let busy = configured(enabled: false)
        NEFixture.managers = [busy]
        NEFixture.failSave = true
        NEFixture.events = []
        let saveFailure = VPNController()
        await expectFailure(.providerUnavailable) { _ = try await saveFailure.prepareManagedState() }
        require(!NEFixture.events.contains("send:1") && !NEFixture.events.contains("start"), "save failure sent a provider request")

        NEFixture.reset()
        NEFixture.managers = [configured(enabled: false)]
        NEFixture.failLoadAt = 2
        NEFixture.events = []
        let reloadFailure = VPNController()
        await expectFailure(.providerUnavailable) { _ = try await reloadFailure.prepareManagedState() }
        require(NEFixture.events.filter { $0 == "save" }.count == 1 && !NEFixture.events.contains("send:1"), "reload failure was retried or sent")

        NEFixture.reset()
        NEFixture.managers = [configured(enabled: false)]
        NEFixture.disableAfterSave = true
        NEFixture.events = []
        let notEnabled = VPNController()
        await expectFailure(.providerUnavailable) { _ = try await notEnabled.prepareManagedState() }
        require(!NEFixture.events.contains("send:1"), "unconfirmed activation sent a provider request")

        NEFixture.reset()
        NEFixture.managers = [configured(enabled: false)]
        NEFixture.changeOwnerOnLoad = true
        NEFixture.events = []
        let changedOwner = VPNController()
        await expectFailure(.localState) { _ = try await changedOwner.prepareManagedState() }
        require(!NEFixture.events.contains("save") && !NEFixture.events.contains("enabled:true"), "changed ownership was overwritten")

        NEFixture.reset()
        NEFixture.managers = [configured(enabled: false, owner: "other")]
        NEFixture.events = []
        let foreign = VPNController()
        await expectFailure(.localState) { _ = try await foreign.prepareManagedState() }
        require(!NEFixture.events.contains("save") && !NEFixture.events.contains("enabled:true"), "foreign manager was overwritten")

        NEFixture.reset()
        NEFixture.managers = [configured(enabled: false), configured(enabled: false)]
        NEFixture.events = []
        let duplicate = VPNController()
        await expectFailure(.localState) { _ = try await duplicate.prepareManagedState() }
        require(!NEFixture.events.contains("save") && !NEFixture.events.contains("enabled:true"), "ambiguous configuration was overwritten")

        NEFixture.reset()
        NEFixture.paired = true
        NEFixture.managers = [configured(enabled: false)]
        NEFixture.events = []
        let connection = VPNController()
        try await connection.connectManaged()
        require(ordered(["enabled:true", "save", "load", "send:1", "start"], in: NEFixture.events), "connect did not activate before starting")
        require(!NEFixture.events.contains("invitation"), "connect submitted an invitation")

        NEFixture.reset()
        NEFixture.managers = [configured(enabled: false)]
        NEFixture.events = []
        let pairing = VPNController()
        let invitation = "kepos1:" + String(repeating: "a", count: 64) + ":" + String(repeating: "b", count: 64)
        await expectFailure(.outcomeUnknown) { _ = try await pairing.pair(invitation: invitation) }
        require(NEFixture.events.filter { $0 == "start" }.count == 1 && NEFixture.events.filter { $0 == "invitation" }.count == 1, "unknown pairing was replayed")
        print("isolated VPN manager behavior passed")
    }
}
