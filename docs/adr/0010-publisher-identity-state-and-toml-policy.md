# ADR 0010: Publisher identity state and TOML policy ownership

Status: Accepted

Date: 2026-09-04

## Context

Publisher state historically stored a seed together with subscriber devices and
a service manifest. The same mutable policy could also be supplied by the
shared TOML file. Keeping two policy snapshots made startup order ambiguous,
left stale authorization on disk, and required callers to support two owners
for one publisher configuration.

## Decision

Publisher durable state is identity-only. The existing `publisher.json` file is
kept as the state document, but its strict schema is exactly:

```json
{ "seed": "<32-byte lowercase hex>" }
```

The state directory must contain that one regular owner-readable file and no
manifest, subscriber list, service list, or other entries. Setup creates it
atomically when absent and reuses the validated seed without rotating the
publisher key. Partial, extra, or malformed state fails closed; no migration or
compatibility parser is provided.

The shared TOML `[publisher]` table is the sole owner of mutable publisher
policy: display name, subscriber-device labels and keys, published services,
and service allowlists. A publisher runtime always receives one complete,
validated policy explicitly. Headless `publisher run` and publisher-enabled
`device run` reject startup when the selected/default TOML lacks that table.
The runtime retains its last valid policy during live TOML reload failures.

Desktop first run writes/ensures its TOML before ensuring the publisher
identity. Desktop pairing persists an approved subscriber to TOML before
applying the new policy in memory. The identity state is never rewritten for a
policy edit.

## Consequences

- Operators have one policy source and one private publisher state file.
- `setup publisher` accepts only a state directory; policy flags and publisher
  state mutation commands are removed.
- Home Manager generates TOML and invokes the identity-only setup command.
- Pairing persistence is an explicit TOML adapter and fails closed when it is
  unavailable.
- Existing deployments must preserve their seed and perform any state cleanup
  as an owned rollout step; automatic migration is intentionally out of scope.

## Supersession

This decision supersedes the state-owned publisher-policy consequences in ADR
0006 and ADR 0007. Their separate role identities, locks, shared transport,
and final-connection pairing lifecycle remain in force; only the publisher
manifest/policy ownership described there is replaced by this ADR.
