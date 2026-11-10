import Foundation
#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif

func require(_ condition: @autoclosure () -> Bool) {
    if !condition() { fatalError("worklet shutdown invariant failed") }
}

func makePeer(_ root: URL) -> ManagedPeerState {
    ManagedPeerState(root: root, existingKey: { _ in "test" }, createKey: { _ in "test" })
}

// Model an abnormal extension process exit while the real lock is held.
if CommandLine.arguments.count == 3 && CommandLine.arguments[1] == "lock-child" {
    let peer = makePeer(URL(fileURLWithPath: CommandLine.arguments[2]))
    _ = try peer.acquireLock()
    _ = write(STDOUT_FILENO, [UInt8(1)], 1)
    var byte: UInt8 = 0
    _ = read(STDIN_FILENO, &byte, 1)
    _exit(1)
}

let temporary = FileManager.default.temporaryDirectory.appendingPathComponent("kepos-shutdown-\(UUID().uuidString)")
try FileManager.default.createDirectory(at: temporary, withIntermediateDirectories: false)
defer { try? FileManager.default.removeItem(at: temporary) }
let root = temporary.appendingPathComponent("peer-state")
let peer = makePeer(root)
func requireLocked() {
    do { let fd = try peer.acquireLock(); _ = close(fd); fatalError("identity lock was released early") }
    catch ManagedVPNError.identityInUse { }
    catch { fatalError("unexpected lock failure: \(error)") }
}

let lock = try peer.acquireLock()
var acknowledgedFirst = WorkletShutdown()
require(acknowledgedFirst.acknowledge() == .wait)
requireLocked()
require(acknowledgedFirst.exited(0) == .finish)
_ = flock(lock, LOCK_UN)
_ = close(lock)
let afterShutdown = try peer.acquireLock()
_ = close(afterShutdown)

var exitedFirst = WorkletShutdown()
require(exitedFirst.exited(0) == .wait)
require(exitedFirst.acknowledge() == .finish)

var failed = WorkletShutdown()
require(failed.acknowledge() == .wait)
require(failed.exited(1) == .fail)

let failedFirst = WorkletShutdown()
var unexpectedExit = failedFirst
require(unexpectedExit.exited(1) == .fail)

var repeated = WorkletShutdown()
require(repeated.acknowledge() == .wait)
require(repeated.acknowledge() == .fail)

let child = Process()
let childInput = Pipe(), childOutput = Pipe()
child.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
child.arguments = ["lock-child", root.path]
child.standardInput = childInput
child.standardOutput = childOutput
try child.run()
require(childOutput.fileHandleForReading.readData(ofLength: 1) == Data([1]))
requireLocked()
try childInput.fileHandleForWriting.write(contentsOf: Data([1]))
child.waitUntilExit()
require(child.terminationStatus == 1)
let afterExit = try peer.acquireLock()
_ = close(afterExit)
print("worklet shutdown ordering tests passed")
