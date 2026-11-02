import Foundation

let sameLANReceiver = vpnHostRoutes(["192.168.1.88"])
assert(sameLANReceiver == [VPNHostRoute(address: "192.168.1.88", mask: "255.255.255.255")])
assert(vpnHostRoutes([]).isEmpty)
let lan = ExistingIPv4Route(destination: "192.168.1.0", isUp: true, isHost: false, isLinkLayer: false, isCloned: false)
let arp = ExistingIPv4Route(destination: "192.168.1.88", isUp: true, isHost: true, isLinkLayer: true, isCloned: true)
let competing = ExistingIPv4Route(destination: "192.168.1.88", isUp: true, isHost: true, isLinkLayer: false, isCloned: false)
let inactive = ExistingIPv4Route(destination: "192.168.1.88", isUp: false, isHost: true, isLinkLayer: false, isCloned: false)
let other = ExistingIPv4Route(destination: "192.168.1.89", isUp: true, isHost: true, isLinkLayer: false, isCloned: false)
let snapshot = LocalIPv4Snapshot(interfaceAddresses: ["192.168.1.124"], routes: [lan, arp])
assert(vpnRouteConflict(local: "198.18.113.9", receivers: ["192.168.1.88"], snapshot: snapshot) == nil)
assert(vpnRouteConflict(local: "192.168.1.124", receivers: ["192.168.1.88"], snapshot: snapshot) == .localAddress)
assert(vpnRouteConflict(local: "198.18.113.9", receivers: ["192.168.1.124"], snapshot: snapshot) == .receiverAddress)
assert(vpnRouteConflict(local: "198.18.113.9", receivers: ["192.168.1.88"], snapshot: LocalIPv4Snapshot(interfaceAddresses: [], routes: [competing])) == .receiverHostRoute)
assert(vpnRouteConflict(local: "198.18.113.9", receivers: ["192.168.1.88"], snapshot: LocalIPv4Snapshot(interfaceAddresses: [], routes: [inactive, other])) == nil)
let destinationSockaddr: [UInt8] = [16, 2, 0, 0, 192, 168, 1, 88, 0, 0, 0, 0, 0, 0, 0, 0]
let gatewaySockaddr: [UInt8] = [8, 18, 0, 0, 1, 2, 3, 4]
let hostMaskSockaddr: [UInt8] = [8, 0, 0, 0, 255, 255, 255, 255]
let decodedHost = try parseDarwinRouteAddresses(destinationSockaddr + gatewaySockaddr + hostMaskSockaddr, addressBits: 7)
assert(decodedHost.destination == "192.168.1.88" && decodedHost.hasHostMask)
let subnetMaskSockaddr: [UInt8] = [7, 0, 0, 0, 255, 255, 255, 0]
let decodedSubnet = try parseDarwinRouteAddresses(destinationSockaddr + subnetMaskSockaddr, addressBits: 5)
assert(decodedSubnet.destination == "192.168.1.88" && !decodedSubnet.hasHostMask)
do {
    _ = try parseDarwinRouteAddresses([16, 2, 0], addressBits: 1)
    fatalError("truncated route accepted")
} catch RouteSnapshotError.invalid {}

func require(_ condition: @autoclosure () -> Bool) {
    if !condition() { fatalError("Worklet framing test failed") }
}

// IPC duplicates the worklet endpoints at construction, so opening it before
// start captures invalid endpoints permanently even if the worklet starts later.
final class FakeWorklet {
    var endpoint: Int? = nil
    func start() { endpoint = 42 }
    func openIPC() -> FakeIPC { FakeIPC(endpoint: endpoint) }
}
struct FakeIPC {
    let endpoint: Int?
    func send(_ bytes: Data) -> Bool { endpoint != nil && !bytes.isEmpty }
}
let fakeWorklet = FakeWorklet()
let startupIPC = startWorkletIPC(start: { fakeWorklet.start() }, openIPC: { fakeWorklet.openIPC() })
require(startupIPC?.send(Data([1])) == true)

let packet = Data(repeating: 0xa5, count: 1400)
let first = try WorkletFrames.encode(kind: WorkletFrames.packet, payload: packet)
let second = try WorkletFrames.encode(kind: WorkletFrames.control, payload: Data("{}".utf8))
var decoder = WorkletFrames()
var decoded: [(UInt8, Data)] = []
for byte in first + second {
    try decoder.append(Data([byte])) { decoded.append(($0, $1)) }
}
try decoder.finish()
require(decoded.count == 2)
require(decoded[0].0 == WorkletFrames.packet && decoded[0].1 == packet)
require(decoded[1].0 == WorkletFrames.control && decoded[1].1 == Data("{}".utf8))

var oversized = WorkletFrames()
do {
    try oversized.append(Data([0x80, 0x01])) { _, _ in }
    fatalError("oversized frame accepted")
} catch WorkletFrameError.invalidFrame {}

var partial = WorkletFrames()
try partial.append(Data([0x00])) { _, _ in }
do {
    try partial.finish()
    fatalError("truncated frame accepted")
} catch WorkletFrameError.truncatedFrame {}

// A fake asynchronous IPC writer keeps its completion pending until ack().
// This exercises the actual bounded queue while writes are in flight.
final class FakeWriter {
    var output = WorkletOutput()
    var active: Data?
    var delivered: [(UInt8, Data)] = []

    func pump() {
        guard active == nil else { return }
        active = output.next()
    }

    func ack() throws {
        guard let frame = active else { fatalError("no write to acknowledge") }
        active = nil
        var decoder = WorkletFrames()
        try decoder.append(frame) { delivered.append(($0, $1)) }
        try decoder.finish()
        output.complete()
        pump()
    }

    func drain() throws {
        pump()
        while active != nil { try ack() }
    }
}

let writer = FakeWriter()
let packets = (0..<5).map { Data(repeating: UInt8($0), count: 20) }
require(writer.output.beginPacketRead())
require(!writer.output.beginPacketRead()) // Only one packetFlow read at a time.
writer.output.finishPacketRead()
try writer.output.enqueuePackets(packets, protocols: Array(repeating: NSNumber(value: 2), count: 5), ipv4: 2)
writer.pump()
require(!writer.output.isIdle)
require(!writer.output.beginPacketRead()) // Backpressure until the batch drains.
require(writer.output.next() == nil) // Never issue parallel writes.
try writer.drain()
require(writer.output.isIdle)
require(writer.output.beginPacketRead()) // A subsequent batch can now be read.
writer.output.finishPacketRead()
require(writer.delivered.map(\.1) == packets)
require(writer.delivered.allSatisfy { $0.0 == WorkletFrames.packet })

// A stalled writer admits only the first 32 valid IPv4 packets, in order.
let overloaded = FakeWriter()
let many = (0..<40).map { Data(repeating: UInt8($0), count: 20) }
let mixed = [Data(repeating: 1, count: 19), Data(repeating: 2, count: 20)] + many
let families = [NSNumber(value: 2), NSNumber(value: 10)] + Array(repeating: NSNumber(value: 2), count: 40)
try overloaded.output.enqueuePackets(mixed, protocols: families, ipv4: 2)
overloaded.pump()
try overloaded.drain()
require(overloaded.delivered.map(\.1) == Array(many.prefix(32)))

// Stop discards waiting packets but lets the active write finish, then sends
// the control frame; resetting tears down any remaining queued state.
let stopping = FakeWriter()
try stopping.output.enqueuePackets(many, protocols: Array(repeating: NSNumber(value: 2), count: 40), ipv4: 2)
stopping.pump()
stopping.output.discardPackets()
try stopping.output.enqueueControl(Data("stop".utf8))
try stopping.drain()
require(stopping.delivered.count == 2)
require(stopping.delivered[0].1 == many[0])
require(stopping.delivered[1].0 == WorkletFrames.control && stopping.delivered[1].1 == Data("stop".utf8))
try stopping.output.enqueuePackets(packets, protocols: Array(repeating: NSNumber(value: 2), count: 5), ipv4: 2)
stopping.output = WorkletOutput()
require(stopping.output.isIdle && stopping.output.next() == nil)
print("worklet framing and output tests passed")
