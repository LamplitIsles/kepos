import AppKit
import Foundation

/// The menu presents managed state; the controller owns pairing and VPN access.
@MainActor
final class KeposMenuBar: NSObject, NSMenuDelegate {
    private let control: any VPNControlling
    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let menu = NSMenu()
    private var managed: ManagedState?
    private var operationInProgress = false
    private var pairing = false
    private var notices = MenuNotices()

    init(control: any VPNControlling) {
        self.control = control
        super.init()
        menu.autoenablesItems = false
        if let image = NSImage(systemSymbolName: "network", accessibilityDescription: "Kepos VPN") {
            image.isTemplate = true
            statusItem.button?.image = image
        } else {
            statusItem.button?.title = "K"
        }
        statusItem.menu = menu
        menu.delegate = self
        control.onStatusChange = { [weak self] _ in self?.render() }
        render()
        Task { await control.refresh() }
        prepare()
    }

    func menuWillOpen(_ menu: NSMenu) {
        Task { await control.refresh() }
    }

    private func add(_ title: String, action: Selector? = nil, enabled: Bool = true) {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
        item.target = action == nil ? nil : self
        item.isEnabled = enabled
        menu.addItem(item)
    }

    private func render() {
        let presentation = MenuPresentation(status: control.status, managed: managed,
                                            busy: operationInProgress, pairing: pairing)
        menu.removeAllItems()
        add(presentation.statusTitle, enabled: false)
        for peer in presentation.peerTitles { add(peer, enabled: false) }
        if let warning = notices.pairingWarning { add(warning, enabled: false) }
        if let error = notices.actionError ?? (control.status.error == nil ? nil : "VPN failed. Check network, configuration and permissions, then reconnect.") {
            add(error, enabled: false)
        }
        menu.addItem(.separator())
        add("Connect", action: #selector(connect), enabled: presentation.canConnect)
        add("Disconnect", action: #selector(disconnect), enabled: presentation.canDisconnect)
        menu.addItem(.separator())
        add("Pair with receiver…", action: #selector(pair), enabled: presentation.canPair)
        if managed == nil && !operationInProgress {
            add("Retry setup", action: #selector(retrySetup), enabled: presentation.canRetrySetup)
        }
        if notices.pairingWarning != nil {
            add("Dismiss pairing notice", action: #selector(dismissPairingNotice), enabled: !operationInProgress)
        }
        add("Copy public key", action: #selector(copyPublicKey), enabled: presentation.canCopyPublicKey)
        menu.addItem(.separator())
        add("Quit Kepos", action: #selector(quit), enabled: !pairing)
    }

    private func prepare() {
        perform(fallback: "Unable to prepare Kepos. Check its local storage and try again.") {
            self.managed = try await self.control.prepareManagedState()
        }
    }

    @objc private func retrySetup() { prepare() }

    @objc private func dismissPairingNotice() { notices.clearPairingWarning(); render() }

    @objc private func pair() {
        guard !operationInProgress, managed != nil else { return }
        let alert = NSAlert()
        alert.messageText = "Pair with receiver"
        alert.informativeText = "Enter the invitation provided by the receiver."
        alert.addButton(withTitle: "Pair")
        alert.addButton(withTitle: "Cancel")
        let field = NSSecureTextField(frame: NSRect(x: 0, y: 0, width: 360, height: 24))
        field.placeholderString = "Invitation"
        field.setAccessibilityLabel("Invitation")
        alert.accessoryView = field
        alert.window.initialFirstResponder = field
        NSApp.activate(ignoringOtherApps: true)
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        let invitation = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        field.stringValue = ""
        guard !invitation.isEmpty else {
            notices.fail("Enter an invitation.", uncertainPairing: false)
            render()
            return
        }
        pairing = true
        perform(fallback: "Pairing could not be confirmed. Check the receiver before retrying.") {
            self.managed = try await self.control.pair(invitation: invitation)
            self.notices.clearPairingWarning()
        }
    }

    @objc private func copyPublicKey() {
        guard let publicKey = managed?.publicKey else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(publicKey, forType: .string)
    }

    @objc private func connect() {
        perform(fallback: "Unable to connect. Check the network and try again.") {
            try await self.control.connectManaged()
        }
    }

    @objc private func disconnect() {
        perform(fallback: "Unable to disconnect. Try again.") { try await self.control.disconnect() }
    }

    private func perform(fallback: String, _ operation: @escaping @MainActor () async throws -> Void) {
        guard !operationInProgress else { return }
        operationInProgress = true
        notices.beginAction()
        render()
        Task {
            do { try await operation() }
            catch {
                let safe = error as? ManagedVPNError
                let uncertainPairing = pairing && pairingRequiresRecheck(safe)
                if uncertainPairing { managed = nil }
                notices.fail(safe?.errorDescription ?? fallback, uncertainPairing: uncertainPairing)
            }
            pairing = false
            operationInProgress = false
            render()
        }
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }
}
