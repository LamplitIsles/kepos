import Foundation
#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif

enum IdentityError: Error {
    case unavailable
    case invalid
}

/// Opens only an existing seed-only identity; this operation never creates files.
struct ExistingIdentity {
    let derivePublicKey: (Data) throws -> Data

    func publicKey(stateDirectory: URL) throws -> String {
        let publicKey = try derivePublicKey(readSeed(stateDirectory: stateDirectory))
        guard publicKey.count == 32 else { throw IdentityError.invalid }
        return publicKey.map { String(format: "%02x", $0) }.joined()
    }

    func readSeed(stateDirectory: URL) throws -> Data {
        let directory = open(stateDirectory.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard directory >= 0 else { throw IdentityError.unavailable }
        defer { _ = close(directory) }
        return try readSeed(directoryDescriptor: directory)
    }

    func readSeed(directoryDescriptor directory: Int32) throws -> Data {
        var directoryStat = stat()
        guard fstat(directory, &directoryStat) == 0,
              (directoryStat.st_mode & mode_t(S_IFMT)) == mode_t(S_IFDIR),
              (directoryStat.st_mode & 0o777) == 0o700 else { throw IdentityError.invalid }

        let listingDescriptor = dup(directory)
        guard listingDescriptor >= 0, let listing = fdopendir(listingDescriptor) else {
            if listingDescriptor >= 0 { _ = close(listingDescriptor) }
            throw IdentityError.unavailable
        }
        defer { closedir(listing) }
        var found = false
        errno = 0
        while let entry = readdir(listing) {
            let name = withUnsafePointer(to: &entry.pointee.d_name) {
                $0.withMemoryRebound(to: CChar.self, capacity: MemoryLayout.size(ofValue: entry.pointee.d_name)) {
                    String(cString: $0)
                }
            }
            if name != "." && name != ".." {
                guard name == "peer.json", !found else { throw IdentityError.invalid }
                found = true
            }
            errno = 0
        }
        guard errno == 0 else { throw IdentityError.unavailable }
        guard found else { throw IdentityError.invalid }

        let file = openat(directory, "peer.json", O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        guard file >= 0 else { throw IdentityError.unavailable }
        defer { _ = close(file) }
        var fileStat = stat()
        guard fstat(file, &fileStat) == 0,
              (fileStat.st_mode & mode_t(S_IFMT)) == mode_t(S_IFREG),
              (fileStat.st_mode & 0o777) == 0o600,
              fileStat.st_uid == directoryStat.st_uid,
              fileStat.st_size >= 0 && fileStat.st_size <= 4096 else { throw IdentityError.invalid }
        var contents = Data()
        var buffer = [UInt8](repeating: 0, count: 512)
        while true {
            let count = read(file, &buffer, buffer.count)
            guard count >= 0 else { throw IdentityError.unavailable }
            if count == 0 { break }
            contents.append(contentsOf: buffer.prefix(count))
            guard contents.count <= 4096 else { throw IdentityError.invalid }
        }
        guard let value = try JSONSerialization.jsonObject(with: contents) as? [String: Any],
              value.count == 1, let seed = value["seed"] as? String,
              seed.utf8.count == 64, seed.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else {
            throw IdentityError.invalid
        }
        var bytes = Data(capacity: 32)
        var index = seed.startIndex
        for _ in 0..<32 {
            let end = seed.index(index, offsetBy: 2)
            guard let byte = UInt8(seed[index..<end], radix: 16) else { throw IdentityError.invalid }
            bytes.append(byte)
            index = end
        }
        return bytes
    }
}
