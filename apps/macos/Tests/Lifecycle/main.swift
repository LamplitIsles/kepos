import Foundation

func require(_ condition: @autoclosure () -> Bool) {
    if !condition() { fatalError("Tunnel lifecycle test failed") }
}

var lifecycle = TunnelLifecycle()
require(lifecycle.observe(.disconnected, at: 0).provider == .disconnected)
lifecycle.prepareStart()
require(lifecycle.observe(.disconnected, at: 100).provider == .connecting)
lifecycle.startSubmitted(at: 100)
require(lifecycle.observe(.disconnected, at: 134.9).provider == .connecting)
let timedOut = lifecycle.observe(.disconnected, at: 135)
require(timedOut.provider == .failed && timedOut.error == "VPN could not start. Check configuration and permissions, then retry.")
require(lifecycle.observe(.disconnected, at: 136) == timedOut)

// A retry clears failure; a visible startup transition followed by disconnect
// reports failure immediately, without waiting for the startup deadline.
lifecycle.prepareStart()
lifecycle.startSubmitted(at: 200)
require(lifecycle.observe(.connecting, at: 200).provider == .connecting)
require(lifecycle.observe(.disconnected, at: 201).provider == .failed)

// A running provider that stops without our request is a failure, including
// when NetworkExtension reports an intermediate disconnecting state.
lifecycle.prepareStart()
lifecycle.startSubmitted(at: 300)
require(lifecycle.observe(.running, at: 301).provider == .running)
require(lifecycle.observe(.disconnecting, at: 302).provider == .disconnecting)
let stopped = lifecycle.observe(.disconnected, at: 303)
require(stopped.provider == .failed && stopped.error == "VPN stopped unexpectedly. Check your network and configuration, then reconnect.")
require(lifecycle.observe(.disconnected, at: 304) == stopped)

// Explicit stop wins even if a late running status arrives first.
lifecycle.prepareStart()
lifecycle.startSubmitted(at: 400)
require(lifecycle.observe(.running, at: 401).provider == .running)
lifecycle.requestStop()
require(lifecycle.observe(.running, at: 402).provider == .disconnecting)
let disconnected = lifecycle.observe(.disconnected, at: 403)
require(disconnected.provider == .disconnected && disconnected.error == nil)

// Cancellation during startup is a normal stop, and an already running VPN
// can be picked up after launching the menu application.
lifecycle.prepareStart()
lifecycle.startSubmitted(at: 500)
lifecycle.requestStop()
require(lifecycle.observe(.disconnected, at: 501).provider == .disconnected)
var existing = TunnelLifecycle()
require(existing.observe(.running, at: 600).provider == .running)
require(existing.observe(.disconnected, at: 601).provider == .failed)
lifecycle.prepareStart()
lifecycle.startFailed()
require(lifecycle.observe(.disconnected, at: 700).provider == .failed)
print("tunnel lifecycle tests passed")
