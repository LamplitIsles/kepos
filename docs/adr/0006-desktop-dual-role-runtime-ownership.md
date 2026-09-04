# ADR 0006: Desktop dual-role runtime ownership

Status: Accepted

Date: 2026-07-25

Superseded in part by ADR 0008 and ADR 0010. The original decision that
Desktop roles do not share a DHT instance is replaced by device-owned shared
HyperDHT transport. Its state-owned publisher-policy consequences are replaced
by identity-only publisher state and TOML-only policy ownership.
Separate role identities, state locks, no implicit self-connection, failure
reporting, and native UI lifecycle remain in force.

## Context

Kepos Desktop already owns one subscriber runtime directly in its Bare process.
The product also needs to share services from the local machine without adding a
child daemon. A desktop may therefore consume services from one remote publisher
while it accepts independent subscribers for its own published services.

Publisher and subscriber states contain different identities. Reusing either
identity from the CLI while desktop owns it can create competing DHT sessions,
replacement races, or conflicting local listeners. ADR 0004 already defines the
desktop singleton and subscriber-state lock but does not cover publisher state.

## Decision

One desktop process may run publisher-only, subscriber-only, or both roles. Each
role keeps its existing state, identity, and connection model:

- the subscriber maintains one outbound connection to one pinned publisher;
- the publisher listens under its own key and keeps one inbound connection per
  active subscriber.

Under ADR 0008, the process owns one shared DHT instance and lends it to every
enabled role. Desktop never connects its subscriber to its own publisher
implicitly.

Desktop keeps the machine-wide singleton from ADR 0004. It also acquires a
per-state lock for every configured role before creating native UI:

```text
.<state-name>.publisher.runtime.lock
.<state-name>.subscriber.runtime.lock
```

The publisher CLI takes the same publisher-state lock. A role holds its lock
until its network runtime has stopped. Startup and runtime failures are isolated:
one failed role does not stop the other or close the control window. Quit stops
publisher first, then subscriber, and attempts every remaining cleanup step.

The first desktop publisher slice reads the seed-only publisher identity and
receives its complete policy from TOML. State setup, service editing,
allowlist editing, and live pairing remain separate work.
On macOS, the same process owns a native menu-bar item and retains its single
WebView control window when the red close button hides it.

Desktop reads the same `~/.config/kepos/config.toml` policy as the CLI. The
optional `enabled` field on each role table controls desktop auto-start; it does
not prevent an explicit CLI run command. State locations are fixed rather than
copied into TOML:

```text
~/.local/state/kepos-neo/publisher
~/.local/state/kepos-neo/subscriber
```

This keeps identity locations predictable and keeps private identity material
out of the shared policy file. A non-default TOML may be selected explicitly,
but it still resolves the same state locations relative to the host's XDG state
home.

The desktop runtime accepts serialized in-process reconfiguration. A changed
publisher configuration restarts only publisher; a changed subscriber
configuration restarts only subscriber. Configuration writes validate the full
candidate, atomically replace TOML, and then apply the desired configuration in
memory. If runtime application fails, TOML remains the desired state and the UI
must report that it was not applied rather than claiming success. A later
configuration UI will use this boundary; this slice does not add editing
controls or filesystem watching.

## Consequences

- A desktop can consume remote services while sharing local services.
- CLI and desktop cannot use the same publisher or subscriber state at once.
- Two enabled roles share one device-owned DHT and one preferred DHT candidate
  listener. HyperDHT still uses an ephemeral DHT client socket and ephemeral
  UDX connection sockets.
- Role combinations are configuration results, not separate product modes.
- The desktop snapshot and UI must distinguish the remote publisher from the
  publisher owned by this machine.
- On macOS, red-button close hides the retained control window without stopping
  either role. Tray Open and Dock reopen show the same window.
- Tray Quit and WebView Quit share one idempotent shutdown that detaches native
  callbacks before stopping the runtimes.

ADR 0006 extends ADR 0004; it does not replace ADR 0004's locking algorithm or
desktop-singleton rules.
