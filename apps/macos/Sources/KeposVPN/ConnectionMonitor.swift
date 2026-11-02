import Foundation

func managerForRefresh<Manager>(cached: Manager?, reloadPreferences: Bool,
                                load: () async throws -> Manager?) async rethrows -> Manager? {
    if !reloadPreferences, let cached { return cached }
    return try await load()
}

/// Watches only the retained connection; replacing it detaches the old observer.
final class ConnectionMonitor {
    private let center: NotificationCenter
    private let name: Notification.Name
    private var token: NSObjectProtocol?

    init(center: NotificationCenter = .default, name: Notification.Name) {
        self.center = center
        self.name = name
    }

    func observe(_ object: NSObject?, onChange: @escaping @Sendable () -> Void) {
        if let token { center.removeObserver(token); self.token = nil }
        guard let object else { return }
        token = center.addObserver(forName: name, object: object, queue: nil) { _ in onChange() }
    }

    deinit { if let token { center.removeObserver(token) } }
}
