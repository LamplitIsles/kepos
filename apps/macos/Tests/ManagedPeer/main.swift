import Foundation
#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif

func require(_ value: @autoclosure () -> Bool) { if !value() { fatalError("managed peer test failed") } }
let temporary = FileManager.default.temporaryDirectory.appendingPathComponent("kepos-managed-peer-\(UUID().uuidString)")
try FileManager.default.createDirectory(at: temporary, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
defer { try? FileManager.default.removeItem(at: temporary) }
let identity = ExistingIdentity { _ in Data(repeating: 9, count: 32) }
var creations = 0
let peer = ManagedPeerState(root: temporary.appendingPathComponent("Kepos"), existingKey: { try identity.publicKey(stateDirectory: $0) }, createKey: { directory in
    if !FileManager.default.fileExists(atPath: directory.path) {
        creations += 1
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        let file = directory.appendingPathComponent("peer.json")
        try Data("{\"seed\":\"\(String(repeating: "07", count: 32))\"}\n".utf8).write(to: file)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    }
    return try identity.publicKey(stateDirectory: directory)
})
let first = try peer.prepare()
require(first == ManagedState(publicKey: String(repeating: "09", count: 32), paired: false))
let second = try peer.prepare()
require(first == second && creations == 1)
let lock = try peer.acquireLock()
do { _ = try peer.prepare(); fatalError("concurrent identity accepted") } catch ManagedVPNError.identityInUse {}
let whileRunning = try peer.prepare(holdingLock: true)
require(whileRunning == first)
_ = flock(lock, LOCK_UN); _ = close(lock)
let config = ManagedConfig(value: ["address": "198.18.8.2", "receiverAddress": "198.18.8.1", "receiverKey": String(repeating: "ab", count: 32)])!
let committed = try peer.commitPair(config, publicKey: first.publicKey)
require(committed == ManagedState(publicKey: first.publicKey, paired: true))
let paired = try peer.prepare()
require(paired == ManagedState(publicKey: first.publicKey, paired: true) && creations == 1)
let response = ManagedStateMessage.response(paired)!
let parsed = try ManagedStateMessage.parse(response)
require(parsed == paired)
require(!String(decoding: response, as: UTF8.self).contains(String(repeating: "07", count: 32)))
do { _ = try ManagedStateMessage.parse(Data("{\"error\":\"secret-value\"}".utf8)); fatalError("arbitrary error accepted") } catch ManagedVPNError.providerUnavailable {}
do { _ = try ManagedStateMessage.parse(Data("{\"publicKey\":\"\(first.publicKey)\",\"paired\":1}".utf8)); fatalError("numeric state accepted") } catch ManagedVPNError.providerUnavailable {}
try FileManager.default.removeItem(at: peer.directory.appendingPathComponent("peer.json"))
do { _ = try peer.prepare(); fatalError("missing paired identity was recreated") } catch IdentityError.invalid {}
require(creations == 1)
let badRoot = temporary.appendingPathComponent("bad")
let badPeer = ManagedPeerState(root: badRoot, existingKey: peer.existingKey, createKey: peer.createKey)
_ = try badPeer.store.read()
try Data("invalid".utf8).write(to: badRoot.appendingPathComponent("config.json"))
do { _ = try badPeer.commitPair(config, publicKey: first.publicKey); fatalError("corrupt state returned pairing success") } catch ManagedVPNError.localState {}
print("managed provider state tests passed")
