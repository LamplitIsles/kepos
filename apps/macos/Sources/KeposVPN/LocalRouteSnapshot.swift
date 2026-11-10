import Darwin
import Foundation

/// Snapshot the actual IPv4 interface addresses and route table. This does
/// not predict subsequent route changes, carrier choices or route precedence.
func localIPv4Snapshot() throws -> LocalIPv4Snapshot {
    var first: UnsafeMutablePointer<ifaddrs>?
    guard getifaddrs(&first) == 0 else { throw ProviderFailure.routeInspectionUnavailable }
    defer { freeifaddrs(first) }
    var addresses = Set<String>()
    var item = first
    while let current = item {
        defer { item = current.pointee.ifa_next }
        guard let raw = current.pointee.ifa_addr, Int32(raw.pointee.sa_family) == AF_INET else { continue }
        var address = UnsafeRawPointer(raw).assumingMemoryBound(to: sockaddr_in.self).pointee.sin_addr
        var output = [CChar](repeating: 0, count: Int(INET_ADDRSTRLEN))
        guard inet_ntop(AF_INET, &address, &output, socklen_t(output.count)) != nil else { throw ProviderFailure.routeInspectionUnavailable }
        addresses.insert(String(cString: output))
    }

    var mib: [Int32] = [CTL_NET, PF_ROUTE, 0, AF_INET, NET_RT_DUMP, 0]
    var size = 0
    guard sysctl(&mib, u_int(mib.count), nil, &size, nil, 0) == 0, size <= 8 * 1024 * 1024 else { throw ProviderFailure.routeInspectionUnavailable }
    #if os(iOS)
    // A sandbox that returns no routing data cannot establish that the
    // requested host route is free; do not treat it as an empty safe table.
    guard size > 0 else { throw ProviderFailure.routeInspectionUnavailable }
    #endif
    var bytes = [UInt8](repeating: 0, count: size)
    let readResult = bytes.withUnsafeMutableBytes { buffer in
        sysctl(&mib, u_int(mib.count), buffer.baseAddress, &size, nil, 0)
    }
    guard readResult == 0, size <= bytes.count else { throw ProviderFailure.routeInspectionUnavailable }
    var routes: [ExistingIPv4Route] = []
    try bytes.withUnsafeBytes { raw in
        var offset = 0
        while offset < size {
            let headerSize = MemoryLayout<rt_msghdr>.size
            guard size - offset >= headerSize else { throw ProviderFailure.routeInspectionUnavailable }
            let header = raw.loadUnaligned(fromByteOffset: offset, as: rt_msghdr.self)
            let length = Int(header.rtm_msglen)
            guard header.rtm_version == RTM_VERSION, length >= headerSize, length <= size - offset else { throw ProviderFailure.routeInspectionUnavailable }
            if header.rtm_addrs & RTA_DST != 0 {
                let addresses = try parseDarwinRouteAddresses(Array(raw[(offset + headerSize)..<(offset + length)]), addressBits: UInt32(bitPattern: header.rtm_addrs))
                if let destination = addresses.destination {
                    let flags = header.rtm_flags
                    routes.append(ExistingIPv4Route(destination: destination, isUp: flags & RTF_UP != 0,
                        isHost: flags & RTF_HOST != 0 || addresses.hasHostMask, isLinkLayer: flags & RTF_LLINFO != 0, isCloned: flags & RTF_WASCLONED != 0))
                }
            }
            offset += length
        }
    }
    return LocalIPv4Snapshot(interfaceAddresses: addresses, routes: routes)
}
