import Foundation

enum TestFailure: Error { case unexpected(String) }

@MainActor
final class FakeController: VPNControlling {
    var status = VPNStatus(provider: .disconnected, peers: nil, error: nil)
    var onStatusChange: ((VPNStatus) -> Void)?
    var prepared = ManagedState(publicKey: "public-key", paired: false)
    var loaded: ManagedState?
    var pairError: Error?
    var prepareError: Error?
    var loadCalls = 0
    var prepareCalls = 0
    var pairCalls = 0
    var connectCalls = 0
    var disconnectCalls = 0
    var submittedInvitation: String?

    func refresh() async { onStatusChange?(status) }
    func loadManagedState() async throws -> ManagedState? {
        loadCalls += 1
        if let prepareError { throw prepareError }
        return loaded
    }
    func prepareManagedState() async throws -> ManagedState {
        prepareCalls += 1
        if let prepareError { throw prepareError }
        return prepared
    }
    func pair(invitation: String) async throws -> ManagedState {
        pairCalls += 1
        submittedInvitation = invitation
        if let pairError { throw pairError }
        return ManagedState(publicKey: prepared.publicKey, paired: true)
    }
    func connectManaged() async throws { connectCalls += 1 }
    func disconnect() async throws { disconnectCalls += 1 }
}

func expect(_ condition: @autoclosure () -> Bool, _ message: String) {
    if !condition() { fatalError(message) }
}

@MainActor
func run() async {
    let control = FakeController()
    let model = KeposScreenModel(controller: control)
    expect(model.canPrepare && !model.canConnect, "setup initially required")
    await model.load()
    expect(control.loadCalls == 1 && control.prepareCalls == 0 && model.canPrepare && model.actionError == nil, "passive load does not activate missing or disabled setup")
    await model.prepare()
    expect(model.publicKey == "public-key" && model.canPair, "setup exposes public key and pairing")
    expect(model.status.peers == nil, "unknown peer state stays unknown")

    let existingControl = FakeController()
    existingControl.loaded = ManagedState(publicKey: "existing-key", paired: true)
    let existingModel = KeposScreenModel(controller: existingControl)
    await existingModel.load()
    expect(existingModel.publicKey == "existing-key" && existingModel.canConnect && existingControl.prepareCalls == 0, "passive load restores an enabled paired state without activating")

    control.pairError = ManagedVPNError.outcomeUnknown
    await model.pair(invitation: "  invitation-secret  ")
    expect(control.submittedInvitation == "invitation-secret", "invitation trimmed")
    expect(model.managed == nil && model.publicKey == "public-key", "unknown outcome retains public key for inspection")
    expect(model.pairingWarning != nil && model.canPrepare, "unknown outcome requires recheck")
    await model.prepare()
    expect(model.pairingWarning != nil && !model.canPair, "local recheck does not establish remote outcome")
    await model.pair(invitation: "invitation-secret")
    expect(control.pairCalls == 1, "no replay before warning is acknowledged")
    model.dismissPairingWarning()
    control.pairError = nil
    await model.pair(invitation: "new-code")
    expect(control.pairCalls == 2 && model.canConnect, "explicit new pairing can succeed")

    await model.connect()
    expect(control.connectCalls == 1, "connect invokes controller")
    control.status = VPNStatus(provider: .running, peers: nil, error: "secret from OS")
    await model.refresh()
    expect(model.canDisconnect && !model.canConnect && model.status.peers == nil, "system VPN and peer state remain distinct")
    await model.disconnect()
    expect(control.disconnectCalls == 1, "disconnect invokes controller")
    control.status = VPNStatus(provider: .failed, peers: nil, error: "secret from OS")
    await model.refresh()
    expect(model.displayError?.contains("reconnect") == true, "failed VPN gives an actionable message")
    expect(!(model.displayError?.contains("secret") ?? true), "failed VPN does not expose underlying status error")
    control.status = VPNStatus(provider: .disconnected, peers: nil, error: nil)
    await model.refresh()
    expect(model.displayError == nil, "recovered status clears the failure message")

    let failingControl = FakeController()
    failingControl.prepareError = TestFailure.unexpected("secret from underlying error")
    let failingModel = KeposScreenModel(controller: failingControl)
    await failingModel.prepare()
    expect(failingModel.actionError != nil && !(failingModel.actionError?.contains("secret") ?? true), "underlying errors are not displayed")
    expect(failingModel.displayError == failingModel.actionError, "operation errors remain the visible explanation")
    failingControl.prepareError = nil
    await failingModel.prepare()
    expect(failingModel.actionError == nil && failingModel.canPair, "successful retry clears transient error")
    failingControl.pairError = TestFailure.unexpected("invitation-secret")
    await failingModel.pair(invitation: "invitation-secret")
    expect(failingModel.pairingWarning != nil && !(failingModel.pairingWarning?.contains("invitation-secret") ?? true), "unknown errors do not expose invitation")

    let unavailableControl = FakeController()
    unavailableControl.prepareError = ManagedVPNError.providerUnavailable
    let unavailableModel = KeposScreenModel(controller: unavailableControl)
    await unavailableModel.prepare()
    expect(unavailableModel.actionError?.contains("selected and allowed") == true, "unavailable provider offers system VPN selection guidance")
    print("Kepos iOS screen behavior passed")
}

await run()
