# ADR 0006: Desktop dual-role runtime ownership

Status: Accepted

Date: 2026-07-25

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
role keeps its existing state, identity, DHT runtime, and connection model:

- the subscriber maintains one outbound connection to one pinned publisher;
- the publisher listens under its own key and keeps one inbound connection per
  active subscriber.

The roles do not share a DHT instance and desktop never connects its subscriber
to its own publisher implicitly.

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

The first desktop publisher slice reads existing publisher state. State setup,
service editing, allowlist editing, live pairing, and tray residence remain
separate work.

## Consequences

- A desktop can consume remote services while sharing local services.
- CLI and desktop cannot use the same publisher or subscriber state at once.
- Two enabled roles create two local DHT owners and may use two UDP sockets.
- The desktop snapshot and UI must distinguish the remote publisher from the
  publisher owned by this machine.
- Closing the window still quits both roles until tray support changes close to
  hide.

ADR 0006 extends ADR 0004; it does not replace ADR 0004's locking algorithm or
desktop-singleton rules.
