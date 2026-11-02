import Foundation
#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif

/// The provider is the sole managed identity and configuration owner.
struct ManagedPeerState {
    let root: URL
    let existingKey: (URL) throws -> String
    let createKey: (URL) throws -> String

    var directory: URL { root.appendingPathComponent("peer", isDirectory: true) }
    var store: ManagedConfigStore { ManagedConfigStore(root: root) }

    func acquireLock() throws -> Int32 {
        try store.prepareDirectory()
        let parent = open(root.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard parent >= 0 else { throw ManagedVPNError.localState }
        defer { _ = close(parent) }
        let fd = openat(parent, ".peer.peer.runtime.lock", O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw ManagedVPNError.localState }
        var info = stat()
        #if canImport(Darwin)
        let fileMask = mode_t(Darwin.S_IFMT), regularFile = mode_t(Darwin.S_IFREG)
        #else
        let fileMask = mode_t(Glibc.S_IFMT), regularFile = mode_t(Glibc.S_IFREG)
        #endif
        guard fstat(fd, &info) == 0, (info.st_mode & fileMask) == regularFile,
              (info.st_mode & 0o777) == 0o600, info.st_uid == getuid() else {
            _ = close(fd); throw ManagedVPNError.localState
        }
        guard flock(fd, LOCK_EX | LOCK_NB) == 0 else {
            let busy = errno == EWOULDBLOCK || errno == EAGAIN
            _ = close(fd); throw busy ? ManagedVPNError.identityInUse : ManagedVPNError.localState
        }
        return fd
    }

    func prepare(holdingLock: Bool = false) throws -> ManagedState {
        let fd = holdingLock ? -1 : try acquireLock()
        defer { if fd >= 0 { _ = flock(fd, LOCK_UN); _ = close(fd) } }
        let config = try store.read()
        // Existing configuration or an active runtime never creates a key.
        let key = try config == nil && !holdingLock ? createKey(directory) : existingKey(directory)
        return ManagedState(publicKey: key, paired: config != nil)
    }

    /// A pairing reply may be returned only after its configuration is durable.
    func commitPair(_ config: ManagedConfig, publicKey: String) throws -> ManagedState {
        try store.save(config)
        return ManagedState(publicKey: publicKey, paired: true)
    }
}
