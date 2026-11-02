import Foundation

/// Tracks this app's start and stop requests separately from NetworkExtension status.
struct TunnelLifecycle {
    private enum Failure {
        case start, unexpectedStop
        var message: String {
            switch self {
            case .start: return "VPN could not start. Check configuration and permissions, then retry."
            case .unexpectedStop: return "VPN stopped unexpectedly. Check your network and configuration, then reconnect."
            }
        }
    }
    private enum Phase {
        case idle, preparing, starting(deadline: TimeInterval, sawTransition: Bool)
        case running, stopping, failed(Failure)
    }
    private var phase: Phase = .idle

    mutating func prepareStart() { phase = .preparing }
    mutating func startSubmitted(at now: TimeInterval) {
        // The provider has a 30-second startup timeout. Allow time for its
        // completion and NE status delivery if intermediate states are missed.
        phase = .starting(deadline: now + 35, sawTransition: false)
    }
    mutating func startFailed() { phase = .failed(.start) }
    mutating func requestStop() { phase = .stopping }

    mutating func observe(_ system: VPNProviderState, at now: TimeInterval) -> VPNStatus {
        switch phase {
        case .preparing:
            return result(.connecting)
        case .starting(let deadline, let sawTransition):
            switch system {
            case .running:
                phase = .running
                return result(.running)
            case .connecting, .disconnecting:
                phase = .starting(deadline: deadline, sawTransition: true)
                return result(system)
            case .disconnected:
                if sawTransition || now >= deadline { phase = .failed(.start); return result(.failed) }
                return result(.connecting)
            case .failed:
                phase = .failed(.start)
                return result(.failed)
            }
        case .running:
            switch system {
            case .disconnected, .failed:
                phase = .failed(.unexpectedStop)
                return result(.failed)
            default: return result(system)
            }
        case .stopping:
            if system == .disconnected { phase = .idle; return result(.disconnected) }
            return result(.disconnecting)
        case .failed:
            if system == .running { phase = .running; return result(.running) }
            if system == .connecting {
                phase = .starting(deadline: now + 35, sawTransition: true)
                return result(.connecting)
            }
            return result(.failed)
        case .idle:
            switch system {
            case .running: phase = .running
            case .connecting: phase = .starting(deadline: now + 35, sawTransition: true)
            case .disconnecting: phase = .stopping
            case .failed: phase = .failed(.unexpectedStop)
            case .disconnected: break
            }
            return result(system)
        }
    }

    private func result(_ provider: VPNProviderState) -> VPNStatus {
        if case .failed(let failure) = phase {
            return VPNStatus(provider: .failed, peers: nil, error: failure.message)
        }
        return VPNStatus(provider: provider, peers: nil, error: nil)
    }
}
