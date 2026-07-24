# ADR 0004: Two-level subscriber runtime locking

Status: Accepted

Date: 2026-07-24

## Context

Kepos can run a subscriber through either the headless CLI or a desktop app.
Both hosts may use the same subscriber state, which contains one cryptographic
identity and one pinned publisher. Running that identity twice can cause local
port conflicts and make the publisher replace one same-key connection with the
other.

The desktop also has a separate product rule: only one Kepos desktop process
and control window may run on a Mac, even if a second launch names another
subscriber state directory.

One lock cannot express both rules:

- a desktop-only global lock does not stop the CLI from using the same state;
- a per-state lock alone permits several desktop processes using different
  state directories.

## Decision

Subscriber hosts use two lock scopes.

The desktop first acquires a machine-local singleton lock:

```text
~/.local/state/kepos-neo/desktop.runtime.lock
```

It does this before creating a window. A second desktop launch is rejected
regardless of its requested subscriber state.

The desktop then acquires the same per-state lock used by the CLI. For a state
directory named `mux-navidrome-subscriber`, the lock is its sibling:

```text
.mux-navidrome-subscriber.subscriber.runtime.lock
```

If the state lock cannot be acquired, desktop releases the singleton and exits
without opening a window. The CLI acquires only the per-state lock, so separate
CLI subscriber states may run independently.

Every lock stores the local PID and a random owner token. Installation writes a
private candidate file and atomically hard-links it to the canonical lock path.
This avoids relying on `open("wx")`: the current Darwin `bare-fs` implementation
does not preserve the required exclusive-create behavior.

On release, the process checks both PID and owner token before deleting the
lock. It cannot delete a replacement owner's lock. If a recorded PID is dead,
a claimant hard-links the stale inode, verifies that the claim and canonical
path still name the same two-link inode, and only then replaces it. Malformed
lock state fails closed because ownership cannot be proved.

The desktop shutdown order is:

1. stop polling;
2. stop the subscriber and its listeners, which releases the state lock;
3. destroy the WebView;
4. release the desktop singleton;
5. close the native process.

## Consequences

- CLI and desktop cannot concurrently use the same state directory.
- Only one desktop process can run, even when several `.app` copies exist.
- A crash may leave lock files, but the next process can reclaim locks whose
  local PID is no longer alive.
- The lock is local process coordination, not authentication or a distributed
  lease. It is not intended for shared network filesystems.
- The per-state path identifies a directory, not the cryptographic key inside
  it. Copying one private identity into two state directories can bypass this
  coordination and remains unsupported.
- A later activation handoff may bring the existing desktop window forward;
  the current spike simply rejects the second launch.

## Alternatives considered

Using only the desktop singleton leaves CLI/desktop collisions possible. Using
only per-state locks weakens the single-window desktop model. Port-bind failure
as implicit coordination happens too late and does not protect the DHT identity.
A local control daemon would add another process and protocol without removing
the need to establish ownership.
