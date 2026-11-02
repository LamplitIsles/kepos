import Foundation

func require(_ condition: @autoclosure () -> Bool) {
    if !condition() { fatalError("Identity test failed") }
}

let root = FileManager.default.temporaryDirectory.appendingPathComponent("kepos-identity-test-\(UUID().uuidString)")
try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
defer { try? FileManager.default.removeItem(at: root) }
let missing = root.appendingPathComponent("missing")
let identity = ExistingIdentity { seed in
    require(seed == Data(repeating: 7, count: 32))
    return Data(repeating: 9, count: 32)
}
do {
    _ = try identity.publicKey(stateDirectory: missing)
    fatalError("missing identity was accepted")
} catch IdentityError.unavailable {}
require(!FileManager.default.fileExists(atPath: missing.path))

let directory = root.appendingPathComponent("peer")
try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
let file = directory.appendingPathComponent("peer.json")
let contents = Data("{\"seed\":\"\(String(repeating: "07", count: 32))\"}\n".utf8)
try contents.write(to: file)
try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
let key = try identity.publicKey(stateDirectory: directory)
require(key == String(repeating: "09", count: 32))
let unchanged = try Data(contentsOf: file)
require(unchanged == contents)
try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: file.path)
do {
    _ = try identity.publicKey(stateDirectory: directory)
    fatalError("unsafe identity was accepted")
} catch IdentityError.invalid {}
try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
let link = root.appendingPathComponent("link")
try FileManager.default.createSymbolicLink(at: link, withDestinationURL: directory)
do {
    _ = try identity.publicKey(stateDirectory: link)
    fatalError("symlinked identity was accepted")
} catch IdentityError.unavailable {}
let moved = root.appendingPathComponent("original.json")
try FileManager.default.moveItem(at: file, to: moved)
try FileManager.default.createSymbolicLink(at: file, withDestinationURL: moved)
do {
    _ = try identity.publicKey(stateDirectory: directory)
    fatalError("symlinked seed was accepted")
} catch IdentityError.unavailable {}
let managed = ManagedConfigStore(root: root.appendingPathComponent("managed"))
let template = try managed.read()
require(template == nil)
let settings = ManagedConfig(value: ["address": "198.18.8.2", "receiverAddress": "198.18.8.1", "receiverKey": String(repeating: "ab", count: 32)])!
try managed.save(settings)
let restored = try managed.read()
require(restored == settings)
require(settings.tunnelConfig.contains("198.18.8.1"))
require(ManagedConfig(value: ["address": "198.18.8.1", "receiverAddress": "198.18.8.1", "receiverKey": String(repeating: "ab", count: 32)]) == nil)
let managedFile = managed.root.appendingPathComponent("config.json")
try Data("invalid".utf8).write(to: managedFile)
do {
    _ = try managed.read()
    fatalError("corrupt managed config was accepted")
} catch ManagedVPNError.localState {}
let corrupt = try Data(contentsOf: managedFile)
require(corrupt == Data("invalid".utf8))
print("existing identity tests passed")
