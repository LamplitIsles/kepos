import Foundation

enum AcceptanceEvent: String, CaseIterable {
    case admissionUnknown = "admission_unknown"
    case admissionAccepted = "admission_accepted"
    case sourceMismatch = "source_mismatch"
    case policyRejected = "policy_rejected"
    case policyAdmitted = "policy_admitted"
    case packetBusy = "packet_busy"
    case packetFlowWriteOK = "packetflow_write_ok"
    case packetFlowWriteFailed = "packetflow_write_failed"

    var fromWorklet: Bool {
        self != .packetFlowWriteOK && self != .packetFlowWriteFailed
    }
}

/// Only fixed events can reach the sink, with at most three of each per provider.
final class AcceptanceDiagnostics {
    private var counts: [AcceptanceEvent: Int] = [:]
    private var mismatchSeen = false
    private let sink: (String) -> Void
    init(sink: @escaping (String) -> Void) { self.sink = sink }

    func worklet(_ raw: String) -> Bool {
        guard let event = AcceptanceEvent(rawValue: raw), event.fromWorklet else { return false }
        if event == .sourceMismatch { mismatchSeen = true }
        record(event)
        return true
    }

    func packetFlowWrite(_ success: Bool) {
        guard mismatchSeen else { return }
        record(success ? .packetFlowWriteOK : .packetFlowWriteFailed)
    }

    private func record(_ event: AcceptanceEvent) {
        guard counts[event, default: 0] < 3 else { return }
        counts[event, default: 0] += 1
        sink(event.rawValue)
    }
}

#if KEPOS_ACCEPTANCE_DIAGNOSTICS && canImport(os)
import os
extension AcceptanceDiagnostics {
    static func systemLogger() -> AcceptanceDiagnostics {
        let logger = Logger(subsystem: "io.lamplitisles.kepos", category: "acceptance")
        return AcceptanceDiagnostics { logger.notice("\($0, privacy: .public)") }
    }
}
#endif
