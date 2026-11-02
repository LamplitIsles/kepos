import AppKit
import Foundation
import UniformTypeIdentifiers

/// Owns the menu only. The controller owns identities, VPN state, and packet flow.
@MainActor
final class KeposMenuBar: NSObject, NSMenuDelegate {
    private let control: any VPNControlling
    private let defaults: UserDefaults
    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let menu = NSMenu()
    private var configURL: URL?
    private var stateDirectory: URL?
    private var publicKey: String?
    private var identitySelection = 0
    private var operationInProgress = false
    private var actionError: String?
    private static let configKey = "vpnConfigPath"
    private static let identityKey = "vpnIdentityPath"

    init(control: any VPNControlling, defaults: UserDefaults = .standard) {
        self.control = control
        self.defaults = defaults
        self.configURL = defaults.string(forKey: Self.configKey).map { URL(fileURLWithPath: $0) }
        self.stateDirectory = defaults.string(forKey: Self.identityKey).map { URL(fileURLWithPath: $0, isDirectory: true) }
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
        restoreIdentity()
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
        let presentation = MenuPresentation(status: control.status, hasConfig: configURL != nil,
                                            hasIdentity: stateDirectory != nil && publicKey != nil, busy: operationInProgress)
        menu.removeAllItems()
        add(presentation.statusTitle, enabled: false)
        for peer in presentation.peerTitles { add(peer, enabled: false) }
        if let error = actionError ?? (control.status.error == nil ? nil : "VPN failed. Check network, configuration and permissions, then reconnect.") {
            add(error, enabled: false)
        }
        menu.addItem(.separator())
        add("Connect", action: #selector(connect), enabled: presentation.canConnect)
        add("Disconnect", action: #selector(disconnect), enabled: presentation.canDisconnect)
        menu.addItem(.separator())
        add("Choose configuration…", action: #selector(chooseConfig), enabled: presentation.canConfigure)
        add(configURL.map { "Configuration: \($0.lastPathComponent)" } ?? "No configuration selected", enabled: false)
        add("Configuration changes apply after reconnecting.", enabled: false)
        add("Create identity…", action: #selector(createIdentity), enabled: presentation.canConfigure)
        add("Choose existing identity…", action: #selector(chooseIdentity), enabled: presentation.canConfigure)
        add(stateDirectory.map { "Identity: \($0.lastPathComponent)" } ?? "No identity selected", enabled: false)
        add("Copy public key", action: #selector(copyPublicKey), enabled: presentation.canConfigure && publicKey != nil)
        menu.addItem(.separator())
        add("Quit Kepos", action: #selector(quit))
    }

    @objc private func chooseConfig() {
        let panel = NSOpenPanel()
        panel.title = "Choose VPN configuration"
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        if let toml = UTType(filenameExtension: "toml") { panel.allowedContentTypes = [toml] }
        if panel.runModal() == .OK, let selected = panel.url {
            configURL = selected
            defaults.set(selected.path, forKey: Self.configKey)
            actionError = nil
            render()
        }
    }

    @objc private func createIdentity() {
        let panel = NSSavePanel()
        panel.title = "Create VPN identity"
        panel.message = "Choose a new folder for this device's identity."
        panel.nameFieldStringValue = "kepos-peer"
        panel.canCreateDirectories = true
        if panel.runModal() == .OK, let selected = panel.url {
            selectIdentity(at: selected, create: true)
        }
    }

    @objc private func chooseIdentity() {
        let panel = NSOpenPanel()
        panel.title = "Choose existing VPN identity folder"
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        if panel.runModal() == .OK, let selected = panel.url {
            selectIdentity(at: selected, create: false)
        }
    }

    private func restoreIdentity() {
        guard let directory = stateDirectory else { return }
        let selection = identitySelection
        Task {
            do {
                let key = try await control.getExistingIdentityPublicKey(stateDirectory: directory)
                guard selection == identitySelection else { return }
                publicKey = key
            } catch {
                guard selection == identitySelection else { return }
                actionError = "Unable to read this identity. Choose an existing identity or create one."
            }
            render()
        }
    }

    private func selectIdentity(at directory: URL, create: Bool) {
        identitySelection += 1
        perform(failure: "Unable to use this identity. Choose another folder.") {
            let publicKey: String
            if create {
                publicKey = try await self.control.prepareIdentity(stateDirectory: directory)
            } else {
                publicKey = try await self.control.getExistingIdentityPublicKey(stateDirectory: directory)
            }
            self.stateDirectory = directory
            self.publicKey = publicKey
            self.defaults.set(directory.path, forKey: Self.identityKey)
        }
    }

    @objc private func copyPublicKey() {
        guard let publicKey else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(publicKey, forType: .string)
    }

    @objc private func connect() {
        guard let configURL, let stateDirectory, publicKey != nil else { return }
        perform(failure: "Unable to connect. Check the configuration and try again.") {
            try await self.control.connect(configURL: configURL, stateDirectory: stateDirectory)
        }
    }

    @objc private func disconnect() {
        perform(failure: "Unable to disconnect. Try again.") { try await self.control.disconnect() }
    }

    private func perform(failure: String, _ operation: @escaping @MainActor () async throws -> Void) {
        guard !operationInProgress else { return }
        operationInProgress = true
        actionError = nil
        render()
        Task {
            do { try await operation() }
            catch { actionError = failure }
            operationInProgress = false
            render()
        }
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }
}
