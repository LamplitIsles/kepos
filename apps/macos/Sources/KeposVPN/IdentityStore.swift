import CryptoKit
import Darwin
import Foundation

struct IdentityStore {
    func existingPublicKey(at directory: URL) throws -> String {
        try existingPeerIdentity().publicKey(stateDirectory: directory)
    }

    func prepare(at directory: URL) throws -> String {
        var info = stat()
        if lstat(directory.path, &info) == 0 { return try existingPublicKey(at: directory) }
        guard errno == ENOENT else { throw IdentityError.unavailable }
        let parent = directory.deletingLastPathComponent()
        let temporary = parent.appendingPathComponent(".kepos-identity-\(UUID().uuidString)", isDirectory: true)
        guard mkdir(temporary.path, 0o700) == 0 else { throw IdentityError.unavailable }
        let file = temporary.appendingPathComponent("peer.json")
        defer { _ = unlink(file.path); _ = rmdir(temporary.path) }
        let descriptor = open(file.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard descriptor >= 0 else { throw IdentityError.unavailable }
        let seed = Curve25519.Signing.PrivateKey().rawRepresentation
        let hex = seed.map { String(format: "%02x", $0) }.joined()
        let bytes = Data("{\n  \"seed\": \"\(hex)\"\n}\n".utf8)
        let complete = bytes.withUnsafeBytes { raw -> Bool in
            guard let base = raw.baseAddress else { return false }
            var offset = 0
            while offset < raw.count {
                let count = write(descriptor, base.advanced(by: offset), raw.count - offset)
                if count <= 0 { return false }
                offset += count
            }
            return fchmod(descriptor, 0o600) == 0 && fsync(descriptor) == 0
        }
        let closed = close(descriptor) == 0
        guard complete && closed else { throw IdentityError.unavailable }
        guard renamex_np(temporary.path, directory.path, UInt32(RENAME_EXCL)) == 0 else {
            // Another creator may have won. Never replace its identity.
            if errno == EEXIST { return try existingPublicKey(at: directory) }
            throw IdentityError.unavailable
        }
        return try existingPublicKey(at: directory)
    }

}
