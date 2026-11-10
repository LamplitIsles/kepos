// Test-owned API-shaped double. It never imports or calls Apple's NetworkExtension.
import Foundation

public enum NEVPNStatus { case invalid, disconnected, connecting, connected, reasserting, disconnecting }

public extension Notification.Name {
    static let NEVPNStatusDidChange = Notification.Name("fixture.ne.status")
}

public enum FixtureFailure: Error { case configurationDisabled }

public enum NEFixture {
    public static var managers: [NETunnelProviderManager] = []
    public static var events: [String] = []
    public static var paired = false
    public static var duringSend: (() -> Void)?
    public static var failSave = false
    public static var failLoadAt: Int?
    public static var loadCount = 0
    public static var disableAfterSave = false
    public static var changeOwnerOnLoad = false

    public static func reset() {
        managers = []
        events = []
        paired = false
        duringSend = nil
        failSave = false
        failLoadAt = nil
        loadCount = 0
        disableAfterSave = false
        changeOwnerOnLoad = false
    }
}

public class NEVPNProtocol: NSObject {}

public final class NETunnelProviderProtocol: NEVPNProtocol {
    public var providerBundleIdentifier: String?
    public var serverAddress: String?
    public var providerConfiguration: [String: Any]?
}

public class NEVPNConnection: NSObject {
    public var status: NEVPNStatus = .disconnected
    public func startVPNTunnel(options: [String: NSObject]? = nil) throws {
        NEFixture.events.append("start")
        status = .connected
    }
    public func stopVPNTunnel() { NEFixture.events.append("stop"); status = .disconnected }
    public func fetchLastDisconnectError() async throws {}
}

public final class NETunnelProviderSession: NEVPNConnection {
    weak var manager: NETunnelProviderManager?

    public func sendProviderMessage(_ message: Data, responseHandler: ((Data?) -> Void)? = nil) throws {
        NEFixture.events.append("send:" + message.map { String($0) }.joined(separator: ","))
        NEFixture.duringSend?()
        guard manager?.isEnabled == true else { throw FixtureFailure.configurationDisabled }
        if message == Data([1]) {
            let state: [String: Any] = ["publicKey": String(repeating: "ab", count: 32), "paired": NEFixture.paired]
            responseHandler?(try JSONSerialization.data(withJSONObject: state))
        } else if message == Data([0]) {
            responseHandler?(Data("{\"running\":true,\"peers\":[]}".utf8))
        } else {
            responseHandler?(nil)
        }
    }

    public override func startVPNTunnel(options: [String: NSObject]? = nil) throws {
        if options?["invitation"] != nil { NEFixture.events.append("invitation") }
        guard manager?.isEnabled == true else { throw FixtureFailure.configurationDisabled }
        try super.startVPNTunnel(options: options)
    }
}

public final class NETunnelProviderManager: NSObject {
    public var protocolConfiguration: NEVPNProtocol?
    public var localizedDescription: String?
    public var isEnabled = false { didSet { NEFixture.events.append("enabled:\(isEnabled)") } }
    public let connection: NEVPNConnection

    public override init() {
        let session = NETunnelProviderSession()
        self.connection = session
        super.init()
        session.manager = self
    }

    public static func loadAllFromPreferences() async throws -> [NETunnelProviderManager] {
        NEFixture.events.append("loadAll")
        return NEFixture.managers
    }

    public func saveToPreferences() async throws {
        NEFixture.events.append("save")
        if NEFixture.failSave { throw FixtureFailure.configurationDisabled }
        if !NEFixture.managers.contains(where: { $0 === self }) { NEFixture.managers.append(self) }
    }

    public func loadFromPreferences() async throws {
        NEFixture.events.append("load")
        NEFixture.loadCount += 1
        if NEFixture.failLoadAt == NEFixture.loadCount { throw FixtureFailure.configurationDisabled }
        if NEFixture.disableAfterSave && NEFixture.loadCount > 1 { isEnabled = false }
        if NEFixture.changeOwnerOnLoad, let proto = protocolConfiguration as? NETunnelProviderProtocol {
            proto.providerConfiguration?["owner"] = "someone-else"
        }
    }
}
