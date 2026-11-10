// In-memory fixture; no Apple NetworkExtension or system preferences are used.
import Foundation

public enum NEVPNStatus { case invalid, disconnected, connecting, connected, reasserting, disconnecting }
public extension Notification.Name { static let NEVPNStatusDidChange = Notification.Name("fixture.ne.status") }
public enum FixtureFailure: Error { case disabled, send }
public enum NEFixture {
    public static var managers: [NETunnelProviderManager] = []
    public static var events: [String] = []
    public static var statusReply: Data?
    public static var holdStatus = false
    public static var throwStatus = false
    public static var statusCallback: ((Data?) -> Void)?
    public static var statusCount = 0
}
public class NEVPNProtocol: NSObject {}
public final class NETunnelProviderProtocol: NEVPNProtocol {
    public var providerBundleIdentifier: String?
    public var serverAddress: String?
    public var providerConfiguration: [String: Any]?
}
public class NEVPNConnection: NSObject {
    public var status: NEVPNStatus = .disconnected
    public var connectedDate: Date? = Date(timeIntervalSince1970: 1)
    public func startVPNTunnel(options: [String: NSObject]? = nil) throws { NEFixture.events.append("start"); status = .connected }
    public func stopVPNTunnel() { NEFixture.events.append("stop"); status = .disconnected }
    public func fetchLastDisconnectError() async throws {}
}
public final class NETunnelProviderSession: NEVPNConnection {
    weak var manager: NETunnelProviderManager?
    public func sendProviderMessage(_ message: Data, responseHandler: ((Data?) -> Void)? = nil) throws {
        guard manager?.isEnabled == true else { throw FixtureFailure.disabled }
        NEFixture.events.append("send:" + message.map { String($0) }.joined(separator: ","))
        if message == Data([0]) {
            NEFixture.statusCount += 1
            if NEFixture.throwStatus { throw FixtureFailure.send }
            if NEFixture.holdStatus { NEFixture.statusCallback = responseHandler }
            else { responseHandler?(NEFixture.statusReply) }
        } else { responseHandler?(nil) }
    }
}
public final class NETunnelProviderManager: NSObject {
    public var protocolConfiguration: NEVPNProtocol?
    public var localizedDescription: String?
    public var isEnabled = false
    public let connection: NEVPNConnection
    public override init() { let session = NETunnelProviderSession(); connection = session; super.init(); session.manager = self }
    public static func loadAllFromPreferences() async throws -> [NETunnelProviderManager] { NEFixture.events.append("loadAll"); return NEFixture.managers }
    public func saveToPreferences() async throws { NEFixture.events.append("save") }
    public func loadFromPreferences() async throws { NEFixture.events.append("load") }
}
