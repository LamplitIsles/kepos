/// A stop response confirms engine cleanup, but the identity lock must remain
/// held until the worklet reports its runtime has torn down. Either event may
/// arrive first; the native exit callback precedes the final thread return.
struct WorkletShutdown {
    enum Decision { case wait, finish, fail }

    private var acknowledged = false
    private var exitCode: Int32?
    var hasAcknowledged: Bool { acknowledged }

    mutating func acknowledge() -> Decision {
        guard !acknowledged else { return .fail }
        acknowledged = true
        return decision
    }

    mutating func exited(_ code: Int32) -> Decision {
        guard exitCode == nil else { return .fail }
        exitCode = code
        return decision
    }

    private var decision: Decision {
        if let exitCode, exitCode != 0 { return .fail }
        return acknowledged && exitCode == 0 ? .finish : .wait
    }
}
