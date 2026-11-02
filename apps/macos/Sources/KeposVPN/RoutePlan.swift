/// Route only the authenticated peers, even when a peer is on the LAN.
struct VPNHostRoute: Equatable {
    let address: String
    let mask: String
}

func vpnHostRoutes(_ peerAddresses: [String]) -> [VPNHostRoute] {
    peerAddresses.map { VPNHostRoute(address: $0, mask: "255.255.255.255") }
}

struct ExistingIPv4Route {
    let destination: String
    let isUp: Bool
    let isHost: Bool
    let isLinkLayer: Bool
    let isCloned: Bool
}

struct LocalIPv4Snapshot {
    let interfaceAddresses: Set<String>
    let routes: [ExistingIPv4Route]
}

struct DarwinRouteAddresses {
    let destination: String?
    let hasHostMask: Bool
}

enum RouteSnapshotError: Error { case invalid }

/// Decode the sockaddrs following a Darwin route message header. Darwin's
/// route ABI pads each sockaddr to a four-byte boundary; a zero length still
/// occupies four bytes. Netmasks can have a shortened sockaddr representation.
func parseDarwinRouteAddresses(_ bytes: [UInt8], addressBits: UInt32) throws -> DarwinRouteAddresses {
    guard addressBits & ~UInt32(0xff) == 0 else { throw RouteSnapshotError.invalid }
    var offset = 0
    var destination: String?
    var hostMask = false
    for index in 0..<8 where addressBits & (1 << index) != 0 {
        guard offset + 2 <= bytes.count else { throw RouteSnapshotError.invalid }
        let length = Int(bytes[offset])
        let padded = length == 0 ? 4 : (length + 3) & ~3
        guard padded <= bytes.count - offset else { throw RouteSnapshotError.invalid }
        if index == 0 && bytes[offset + 1] == 2 { // Darwin AF_INET
            guard length >= 8 else { throw RouteSnapshotError.invalid }
            destination = (4..<8).map { String(bytes[offset + $0]) }.joined(separator: ".")
        }
        if index == 2 && length >= 8 {
            hostMask = (4..<8).allSatisfy { bytes[offset + $0] == 255 }
        }
        offset += padded
    }
    return DarwinRouteAddresses(destination: destination, hasHostMask: hostMask)
}

enum VPNRouteConflict: Equatable {
    case localAddress, receiverAddress, receiverHostRoute
}

/// Compare exact addresses only. A LAN subnet or its cloned ARP route does
/// not by itself conflict with the explicitly selected receiver host route.
func vpnRouteConflict(local: String, receivers: [String], snapshot: LocalIPv4Snapshot) -> VPNRouteConflict? {
    if snapshot.interfaceAddresses.contains(local) { return .localAddress }
    if receivers.contains(where: snapshot.interfaceAddresses.contains) { return .receiverAddress }
    if snapshot.routes.contains(where: { $0.isUp && $0.isHost && !$0.isLinkLayer && !$0.isCloned && receivers.contains($0.destination) }) {
        return .receiverHostRoute
    }
    return nil
}
