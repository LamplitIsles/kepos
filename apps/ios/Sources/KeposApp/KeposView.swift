import SwiftUI
import UIKit

struct KeposView: View {
    let model: KeposScreenModel
    @Environment(\.scenePhase) private var scenePhase
    @State private var invitation = ""
    @State private var showingInvitation = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack(spacing: 14) {
                        Image(systemName: model.status.provider == .running ? "lock.shield.fill" : "lock.shield")
                            .font(.title2)
                            .foregroundStyle(model.status.provider == .running ? Color.green : Color.secondary)
                            .accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(vpnTitle).font(.headline)
                            Text(receiverTitle).font(.subheadline).foregroundStyle(.secondary)
                        }
                        Spacer()
                        if model.busy { ProgressView().accessibilityLabel("Working") }
                    }
                    if model.canDisconnect {
                        Button("Disconnect") { Task { await model.disconnect() } }
                    } else if model.managed?.paired == true {
                        Button("Connect") { Task { await model.connect() } }
                            .disabled(!model.canConnect)
                    } else if model.managed != nil {
                        Button("Pair with receiver") { showingInvitation = true }
                            .disabled(!model.canPair)
                    } else {
                        Button(model.actionError == nil ? "Set up Kepos" : "Retry setup") { Task { await model.prepare() } }
                            .disabled(!model.canPrepare)
                    }
                } header: {
                    Text("Connection")
                }

                if let warning = model.pairingWarning {
                    Section("Check pairing") {
                        Text(warning)
                        if model.canPrepare {
                            Button("Recheck this iPhone") { Task { await model.prepare() } }
                        }
                        Button("I checked with the receiver") { model.dismissPairingWarning() }
                    }
                }

                if let error = model.displayError {
                    Section("Needs attention") {
                        Text(error)
                    }
                }

                if let key = model.publicKey {
                    Section {
                        Button {
                            UIPasteboard.general.string = key
                        } label: {
                            Label("Copy public key", systemImage: "doc.on.doc")
                        }
                    } footer: {
                        Text("Use this public key to identify this iPhone to the receiver operator.")
                    }
                }
            }
            .navigationTitle("Kepos")
            .task { await model.load() }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active { Task { await model.refresh() } }
            }
            .sheet(isPresented: $showingInvitation, onDismiss: { invitation = "" }) {
                NavigationStack {
                    Form {
                        Section {
                            SecureField("Invitation code", text: $invitation)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                        } footer: {
                            Text("Paste the invitation provided by the receiver operator.")
                        }
                    }
                    .navigationTitle("Pair with receiver")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("Cancel") { showingInvitation = false }
                        }
                        ToolbarItem(placement: .confirmationAction) {
                            Button("Pair") {
                                let code = invitation
                                invitation = ""
                                showingInvitation = false
                                Task { await model.pair(invitation: code) }
                            }
                            .disabled(invitation.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !model.canPair)
                        }
                    }
                }
            }
        }
    }

    private var vpnTitle: String {
        switch model.status.provider {
        case .disconnected: return "VPN disconnected"
        case .connecting: return "Connecting…"
        case .running: return "VPN on"
        case .disconnecting: return "Disconnecting…"
        case .failed: return "VPN unavailable"
        }
    }

    private var receiverTitle: String {
        guard let managed = model.managed else { return "Setup needed" }
        guard managed.paired else { return "Not paired" }
        guard model.status.provider == .running else { return "Receiver configured" }
        guard let peers = model.status.peers else { return "Receiver status unavailable" }
        return peers.contains(where: \.connected) ? "Receiver connected" : "Receiver not connected"
    }
}
