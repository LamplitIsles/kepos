import Foundation

func require(_ condition: @autoclosure () -> Bool) {
    if !condition() { fatalError("Provider status test failed") }
}
let key = String(repeating: "ab", count: 32)
func message(_ peers: String, running: String = "true") -> Data {
    Data("{\"running\":\(running),\"peers\":\(peers)}".utf8)
}
let peer = "{\"publicKey\":\"\(key)\",\"label\":\"remote\",\"connected\":true}"
require(ProviderStatus.peers(from: message("[\(peer)]")) == [VPNPeerStatus(publicKey: key, label: "remote", connected: true)])
// Simulate the provider's JSONSerialization response for a running zero-peer tunnel.
let emptySnapshot: [String: Any] = ["running": true, "peers": [[String: Any]]()]
let emptyReply = try JSONSerialization.data(withJSONObject: emptySnapshot)
require(ProviderStatus.peers(from: emptyReply) == [])
require(ProviderStatus.peers(from: message("[]", running: "false")) == nil)
require(ProviderStatus.peers(from: message("[\(peer),\(peer)]")) == nil)
require(ProviderStatus.peers(from: message("[\(peer)]", running: "false")) == nil)
require(ProviderStatus.peers(from: message("[{\"publicKey\":\"\(key)\",\"label\":\"remote\",\"connected\":1}]")) == nil)
require(ProviderStatus.peers(from: Data(repeating: 0x20, count: 32_769)) == nil)
let provider = "io.example.kepos.tunnel"
require(mayReplaceExtension(expected: provider, request: provider, existing: provider, incoming: provider))
require(!mayReplaceExtension(expected: nil, request: provider, existing: provider, incoming: provider))
require(!mayReplaceExtension(expected: "", request: "", existing: "", incoming: ""))
require(!mayReplaceExtension(expected: provider, request: "other", existing: provider, incoming: provider))
require(!mayReplaceExtension(expected: provider, request: provider, existing: "other", incoming: provider))
require(!mayReplaceExtension(expected: provider, request: provider, existing: provider, incoming: "other"))

var gate = StatusRequestGate()
var attempts: [Int] = []
for millisecond in 0...6_000 {
    if gate.allow(at: Double(millisecond) / 1_000) { attempts.append(millisecond) }
}
require(attempts == [0, 2_000, 4_000, 6_000])
require(!gate.allow(at: 6.001))

final class Capture: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String] = []
    func add(_ value: String) { lock.lock(); values.append(value); lock.unlock() }
    func snapshot() -> [String] { lock.lock(); defer { lock.unlock() }; return values }
}

// Fake a preference reload that emits notifications for newly loaded connections.
// Only the retained connection may cause a refresh, and replacing it detaches the old one.
let center = NotificationCenter()
let notification = Notification.Name("test.vpn.status")
let connectionOne = NSObject()
let connectionTwo = NSObject()
let monitorEvents = Capture()
var monitor: ConnectionMonitor? = ConnectionMonitor(center: center, name: notification)
monitor?.observe(connectionOne) {
    monitorEvents.add("owned change")
    for _ in 0..<100 { center.post(name: notification, object: NSObject()) }
}
center.post(name: notification, object: NSObject())
require(monitorEvents.snapshot().isEmpty)
center.post(name: notification, object: connectionOne)
require(monitorEvents.snapshot() == ["owned change"])
monitor?.observe(connectionTwo) { monitorEvents.add("replacement change") }
center.post(name: notification, object: connectionOne)
center.post(name: notification, object: connectionTwo)
require(monitorEvents.snapshot() == ["owned change", "replacement change"])

// Notifications and periodic status reads reuse a retained manager, while an
// explicit refresh (or a missing manager) still loads the preferences.
let loads = Capture()
let cached = await managerForRefresh(cached: connectionOne, reloadPreferences: false) {
    loads.add("load")
    return connectionTwo
}
require(cached === connectionOne && loads.snapshot().isEmpty)
let explicit = await managerForRefresh(cached: connectionOne, reloadPreferences: true) {
    loads.add("explicit")
    return connectionTwo
}
require(explicit === connectionTwo && loads.snapshot() == ["explicit"])
let missing = await managerForRefresh(cached: Optional<NSObject>.none, reloadPreferences: false) {
    loads.add("missing")
    return connectionTwo
}
require(missing === connectionTwo && loads.snapshot() == ["explicit", "missing"])

monitor = nil
center.post(name: notification, object: connectionTwo)
require(monitorEvents.snapshot() == ["owned change", "replacement change"])

let capture = Capture()
let diagnostics = StatusDiagnostics { capture.add($0) }
let first = diagnostics.begin()
let second = diagnostics.begin()
let third = diagnostics.begin()
require(first == 1 && second == 2 && third == 3 && diagnostics.begin() == nil)
diagnostics.record(first, .request)
diagnostics.record(second, .peerCount(0))
diagnostics.record(third, .peerCount(16))
diagnostics.record(first, .peerCount(Int.max))
diagnostics.record(first, .peerCount(-1))
// Hostile peer content is never passed to the diagnostic sink.
let secret = "SECRET_TEST_ONLY_PATH_LABEL_KEY_BYTES"
require(ProviderStatus.peers(from: Data(secret.utf8)) == nil)
diagnostics.record(first, .decodeRejected)
diagnostics.record(nil, .replyData)
diagnostics.record(4, .replyData)
DispatchQueue.concurrentPerform(iterations: 100) { _ in diagnostics.record(third, .timeout) }
let lines = capture.snapshot()
require(lines.count == 36)
require(lines.contains("cycle=2 event=peer_count_0"))
require(lines.contains("cycle=3 event=peer_count_16"))
require(lines.filter { $0 == "cycle=1 event=peer_count_overflow" }.count == 2)
require(lines.allSatisfy { !$0.contains(secret) && !$0.contains("cycle=4") })
let winners = Capture()
let reply = StatusReply { outcome in
    switch outcome {
    case .data: winners.add("data")
    case .nilReply: winners.add("nil")
    case .timeout: winners.add("timeout")
    case .sendError: winners.add("throw")
    }
}
reply.finish(.nilReply)
reply.finish(.data(Data(secret.utf8)))
reply.finish(.timeout)
require(winners.snapshot() == ["nil"])

var acceptanceLines: [String] = []
let acceptance = AcceptanceDiagnostics { acceptanceLines.append($0) }
acceptance.packetFlowWrite(true)
require(acceptanceLines.isEmpty) // Earlier ordinary traffic cannot exhaust the control budget.
require(!acceptance.worklet(secret))
require(!acceptance.worklet("packetflow_write_ok")) // Only Swift can report a packetFlow write.
for event in AcceptanceEvent.allCases where event.fromWorklet {
    for _ in 0..<20 { require(acceptance.worklet(event.rawValue)) }
}
for _ in 0..<20 { acceptance.packetFlowWrite(true); acceptance.packetFlowWrite(false) }
require(acceptanceLines.count == AcceptanceEvent.allCases.count * 3)
require(AcceptanceEvent.allCases.allSatisfy { event in acceptanceLines.filter { $0 == event.rawValue }.count == 3 })
require(acceptanceLines.allSatisfy { !$0.contains(secret) })
print("provider status tests passed")
