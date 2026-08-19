# Windows 10 desktop dogfood findings — 2026-08-18

Status: unresolved follow-up work

This record captures issues observed while running the portable Windows desktop
artifact on a separate Windows 10 x64 machine. It intentionally omits private
keys, complete public keys, public addresses, credentials, and packet captures.
The original capture remained local to the debugging session.

## Tested path

- Artifact: `dist/release/rehearsal-v0.3.0/kepos-windows-x64.zip`
- Distribution shape: extract the complete `Kepos` directory and run
  `Kepos\App\Kepos.exe`; the executable cannot be moved or distributed alone.
- Subscriber state belonged to the test Windows account under
  `%LOCALAPPDATA%\Kepos\state\subscriber`.
- Config belonged to the same account under `%APPDATA%\Kepos\config.toml`.
- Publisher ran on the NUC WSL deployment and loaded an immutable generated
  config containing the test subscriber public key.

## Established facts

1. The ZIP and executable were intact. The same extracted rehearsal payload
   opened a visible `Kepos` window repeatedly on the Windows 11 build host.
2. Initial Windows 10 launch exited before showing a window with native status
   `0xC0000409`.
3. Installing the matching Microsoft Windows App Runtime 1.8 x64 runtime made
   the same executable open on Windows 10; no separate Kepos binary was needed.
4. Subscriber config, identity, and publisher contact parsed successfully. The
   local gateway listened on port 17480 and returned `503 Service Unavailable`
   while no publisher tunnel was available.
5. Kepos created UDP sockets and repeatedly transmitted DHT bootstrap packets
   to every configured bootstrap endpoint.
6. PktMon observed those packets moving from Windows TCP/IP into
   `wintun.sys` / `Meta Tunnel` with a synthetic `198.18.0.0/15` source. It
   observed no matching receive traffic during the sample and no Windows
   component drop counter for the filtered packets.
7. The NUC publisher was healthy, accepted other subscribers, and had the test
   subscriber in its active allowlist, but did not observe this subscriber while
   the Windows TUN path was enabled.
8. Disabling Clash/Mihomo TUN allowed the subscriber path to connect. This is a
   differential result: the proven failure boundary is the TUN/upstream path,
   not Kepos config parsing or publisher authorization.
9. After connectivity recovered, the desktop UI still displayed `Connecting`.
   Connection state shown by the UI therefore diverged from live behavior.

## Product and implementation issues

### 1. Hidden Windows App Runtime prerequisite

The portable ZIP currently uses framework-dependent Windows App SDK deployment.
It includes the bootstrap DLL but not the Windows App Runtime framework itself.
On a machine without the matching runtime, native bootstrap failure is ignored
and WinUI later terminates through fail-fast, producing no actionable message.

The matching runtime used in this test was Microsoft Windows App Runtime 1.8.3
(`1.8.251106002`) x64. Microsoft documents Windows App SDK 1.8 as technically
compatible with Windows 10 version 1809 and later, although OS servicing support
still depends on the Windows edition and lifecycle.

Follow-up decision:

- either keep a framework-dependent ZIP and provide an explicit prerequisite
  check, error dialog, installer link, and documentation;
- or produce a self-contained Windows App SDK deployment so extraction is
  genuinely sufficient on a clean supported machine.

The current documentation claim that extraction alone is sufficient is not true
for a clean machine without Windows App Runtime.

### 2. First-run onboarding state was inconsistent

With only `client.identity.json` present and no publisher contact, the expected
`Connect this subscriber` form did not appear; the UI remained on `Connecting`.
The publisher contact had to be created manually. Root cause is not established:
it may be a stale/initial snapshot path or a mismatch between the payload used
and the expected first-run UI behavior.

The valid contact schema requires all three fields:

```json
{
  "publisherKey": "<publisher-public-key>",
  "label": "<publisher-label>",
  "requestedLocalPort": 0
}
```

A trailing newline is optional. The subscriber identity must be preserved.

### 3. Generated default config was insufficient for this deployment

Automatic bootstrap enabled subscriber mode but did not know the deployment's
custom DHT bootstrap endpoints or desired raw-service listeners. The test needed
a subscriber-only `config.toml` with the same bootstrap network as the publisher
and explicit local ports. Copying a publisher section from another device would
be incorrect.

The product needs a supported onboarding mechanism for deployment/bootstrap
configuration rather than requiring manual TOML editing.

### 4. Desktop observability was inadequate

The WinUI runtime redirects stdout and stderr to `NUL`, and the desktop app does
not persist transport observations. Native startup failures, config failures,
DHT attempts, selected routes, connection generations, and registry refresh
errors were therefore invisible to the user and difficult to diagnose remotely.

A follow-up should add bounded, redacted logs under a user-owned path such as
`%LOCALAPPDATA%\Kepos\logs`, plus a UI action to copy a sanitized diagnostic
summary. Logs must never include secret keys, invitation tokens, or full peer
addresses.

### 5. TUN/VPN interaction needs an explicit contract

Clash/Mihomo TUN captured Kepos UDP and did not return bootstrap responses in
this environment. The immediate workaround was to disable TUN. A durable setup
may use an early process rule such as `PROCESS-NAME,Kepos.exe,DIRECT`, but that
must be tested against the active persistent profile, generated config, and live
route. Editing generated YAML alone is not sufficient.

Kepos documentation should explain that HyperDHT requires bidirectional UDP and
include a TUN/VPN diagnostic. The app should surface when bootstrap requests are
transmitted repeatedly without responses.

### 6. UI connection state became stale

After the transport path connected with TUN disabled, the main window continued
to show `Connecting`. The runtime-to-controller-to-WebView snapshot path needs a
regression test covering a real `connecting -> connected` transition followed
by registry refresh. Connection display must not depend on reopening the window
or restarting the app.

## Follow-up order

1. Fix and test the stale `Connecting` snapshot/UI transition.
2. Add persistent sanitized desktop diagnostics and native bootstrap error
   reporting.
3. Decide framework-dependent prerequisite versus self-contained deployment;
   make packaging and documentation truthful for the selected model.
4. Reproduce first-run onboarding from empty Windows user roots and fix the
   missing connect form.
5. Add Windows 10 compatibility as an explicit target only after testing the
   selected deployment model on Windows 10 build 19045 and Windows 11 x64.
6. Validate a persistent Mihomo/Clash process-level DIRECT rule, then repeat the
   external peer, service registry, close/reopen, and restart matrix.

## Acceptance boundary

This run proves that the current binary can execute on the tested Windows 10
machine after installing the matching Windows App Runtime, and that TUN was the
observed connectivity blocker. It does not yet establish supported Windows 10
distribution, clean-machine portability, correct first-run onboarding, current
UI status, or the complete external-peer service matrix.
