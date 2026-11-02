import Foundation

enum StatusOutcome: Sendable {
    case data(Data), nilReply, timeout, sendError
}

// Notification bursts must not turn a failed status request into a busy retry loop.
struct StatusRequestGate {
    private var lastRequest: TimeInterval?
    mutating func allow(at now: TimeInterval) -> Bool {
        if let lastRequest, now - lastRequest < 2 { return false }
        lastRequest = now
        return true
    }
}

final class StatusReply: @unchecked Sendable {
    private let lock = NSLock()
    private var completion: (@Sendable (StatusOutcome) -> Void)?
    init(_ completion: @escaping @Sendable (StatusOutcome) -> Void) { self.completion = completion }
    func finish(_ outcome: StatusOutcome) {
        lock.lock()
        let callback = completion
        completion = nil
        lock.unlock()
        callback?(outcome)
    }
}

// Only fixed categories and a bounded peer count can reach the sink.
enum StatusDiagnosticEvent {
    case request, sessionReady, sessionMissing, replyData, replyNil, timeout, sendError
    case generationCurrent, generationStale, connectionChanged, decoded, decodeRejected
    case handler, handlerNoCompletion, providerRunning, providerStopped, peerCount(Int)
    case encoded, encodeFailed

    var code: String {
        switch self {
        case .request: return "request"
        case .sessionReady: return "session_ready"
        case .sessionMissing: return "session_missing"
        case .replyData: return "reply_data"
        case .replyNil: return "reply_nil"
        case .timeout: return "timeout"
        case .sendError: return "send_error"
        case .generationCurrent: return "generation_current"
        case .generationStale: return "generation_stale"
        case .connectionChanged: return "connection_changed"
        case .decoded: return "decoded"
        case .decodeRejected: return "decode_rejected"
        case .handler: return "handler"
        case .handlerNoCompletion: return "handler_no_completion"
        case .providerRunning: return "provider_running"
        case .providerStopped: return "provider_stopped"
        case .peerCount(let count): return (0...16).contains(count) ? "peer_count_\(count)" : "peer_count_overflow"
        case .encoded: return "encoded"
        case .encodeFailed: return "encode_failed"
        }
    }
}

final class StatusDiagnostics: @unchecked Sendable {
    private let lock = NSLock()
    private var cycles = 0
    private var events = 0
    private let sink: @Sendable (String) -> Void
    init(sink: @escaping @Sendable (String) -> Void) { self.sink = sink }
    func begin() -> Int? {
        lock.lock()
        defer { lock.unlock() }
        guard cycles < 3 else { return nil }
        cycles += 1
        return cycles
    }
    func record(_ cycle: Int?, _ event: StatusDiagnosticEvent) {
        lock.lock()
        guard let cycle, cycle > 0, cycle <= cycles, events < 36 else { lock.unlock(); return }
        events += 1
        lock.unlock()
        sink("cycle=\(cycle) event=\(event.code)")
    }
}

#if KEPOS_STATUS_DIAGNOSTICS && canImport(os)
import os
extension StatusDiagnostics {
    enum Process { case host, provider }
    static func systemLogger(_ process: Process) -> StatusDiagnostics {
        let logger = Logger(subsystem: "io.lamplitisles.kepos", category: process == .host ? "status-host" : "status-provider")
        return StatusDiagnostics { logger.notice("\($0, privacy: .public)") }
    }
}
#endif
