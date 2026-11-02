import Foundation
#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif

struct ManagedConfig: Equatable {
    let address: String
    let receiverAddress: String
    let receiverKey: String

    init?(value: Any) {
        guard let object = value as? [String: Any], Set(object.keys) == Set(["address", "receiverAddress", "receiverKey"]),
              let address = object["address"] as? String, Self.validAddress(address),
              let receiverAddress = object["receiverAddress"] as? String, Self.validAddress(receiverAddress), address != receiverAddress,
              let receiverKey = object["receiverKey"] as? String, receiverKey.utf8.count == 64,
              receiverKey.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else { return nil }
        self.address = address
        self.receiverAddress = receiverAddress
        self.receiverKey = receiverKey
    }

    var value: [String: String] { ["address": address, "receiverAddress": receiverAddress, "receiverKey": receiverKey] }
    var tunnelConfig: String {
        """
        peers = [{ label = "receiver", public_key = "\(receiverKey)", connection = "dial" }]
        [vpn]
        address = "\(address)"
        peers = [{ peer = "receiver", address = "\(receiverAddress)", allow_tcp = [] }]
        """
    }

    private static func validAddress(_ value: String) -> Bool {
        let parts = value.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4 else { return false }
        let bytes = parts.compactMap { UInt8($0) }
        guard bytes.count == 4, zip(parts, bytes).allSatisfy({ String($0.1) == $0.0 }) else { return false }
        return bytes[0] != 0 && bytes[0] != 127 && bytes[0] < 224 && !(bytes[0] == 169 && bytes[1] == 254)
    }
}

/// The root is a private, app-managed directory inside the shared container.
struct ManagedConfigStore {
    let root: URL
    private let filename = "config.json"

    func prepareDirectory() throws {
        if mkdir(root.path, 0o700) != 0 && errno != EEXIST { throw ManagedVPNError.localState }
        var info = stat()
        guard lstat(root.path, &info) == 0, (info.st_mode & mode_t(S_IFMT)) == mode_t(S_IFDIR),
              (info.st_mode & 0o777) == 0o700, info.st_uid == getuid() else { throw ManagedVPNError.localState }
    }

    func read() throws -> ManagedConfig? {
        try prepareDirectory()
        let directory = open(root.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard directory >= 0 else { throw ManagedVPNError.localState }
        defer { _ = close(directory) }
        var descriptor = openat(directory, filename, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        if descriptor < 0 && errno == ENOENT {
            let created = openat(directory, filename, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
            if created >= 0 {
                let bytes = Data("{}\n".utf8)
                let ok = bytes.withUnsafeBytes { raw in write(created, raw.baseAddress!, raw.count) == raw.count } && fsync(created) == 0
                let closed = close(created) == 0
                guard ok && closed && fsync(directory) == 0 else { throw ManagedVPNError.localState }
            } else if errno != EEXIST { throw ManagedVPNError.localState }
            descriptor = openat(directory, filename, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        }
        guard descriptor >= 0 else { throw ManagedVPNError.localState }
        defer { _ = close(descriptor) }
        var info = stat()
        guard fstat(descriptor, &info) == 0, (info.st_mode & mode_t(S_IFMT)) == mode_t(S_IFREG),
              (info.st_mode & 0o777) == 0o600, info.st_uid == getuid(), info.st_size >= 0, info.st_size <= 4096 else { throw ManagedVPNError.localState }
        var contents = Data(), buffer = [UInt8](repeating: 0, count: 512)
        while true {
            let count = DarwinOrGlibcRead(descriptor, &buffer, buffer.count)
            guard count >= 0 else { throw ManagedVPNError.localState }
            if count == 0 { break }
            contents.append(contentsOf: buffer.prefix(count))
            guard contents.count <= 4096 else { throw ManagedVPNError.localState }
        }
        guard let value = try? JSONSerialization.jsonObject(with: contents), let object = value as? [String: Any] else { throw ManagedVPNError.localState }
        if object.isEmpty { return nil }
        guard let config = ManagedConfig(value: object) else { throw ManagedVPNError.localState }
        return config
    }

    func save(_ config: ManagedConfig) throws {
        _ = try read() // Validate the current template/config before replacing it.
        let directory = open(root.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard directory >= 0 else { throw ManagedVPNError.localState }
        defer { _ = close(directory) }
        let temporary = ".config-\(UUID().uuidString)"
        let descriptor = openat(directory, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard descriptor >= 0 else { throw ManagedVPNError.localState }
        defer { _ = unlinkat(directory, temporary, 0) }
        let data = try JSONSerialization.data(withJSONObject: config.value, options: [.sortedKeys])
        let complete = data.withUnsafeBytes { raw -> Bool in
            guard let base = raw.baseAddress else { return false }
            var offset = 0
            while offset < raw.count {
                let count = write(descriptor, base.advanced(by: offset), raw.count - offset)
                if count <= 0 { return false }
                offset += count
            }
            return fsync(descriptor) == 0
        }
        let closed = close(descriptor) == 0
        guard complete && closed, renameat(directory, temporary, directory, filename) == 0, fsync(directory) == 0 else { throw ManagedVPNError.localState }
    }
}

private func DarwinOrGlibcRead(_ descriptor: Int32, _ buffer: UnsafeMutableRawPointer, _ count: Int) -> Int {
    #if canImport(Darwin)
    return Darwin.read(descriptor, buffer, count)
    #else
    return Glibc.read(descriptor, buffer, count)
    #endif
}
