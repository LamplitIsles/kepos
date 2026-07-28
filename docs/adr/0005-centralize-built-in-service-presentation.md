# ADR 0005: Centralize built-in service presentation

Status: Accepted

Date: 2026-07-24

## Context

The publisher registry describes service identity and transport, but it does
not say whether a client should open a service, copy an address, copy a command,
or only show it. Android and desktop need the same product behavior without
duplicating service-id checks in Kotlin and WebView code.

## Decision

`src/runtime/service-handlers.ts` is the single source of truth for built-in
service presentation. It maps a service id to its action, icon, and sort group,
then produces the full client-facing service list.

The current policy is:

| Service | Action | Icon |
| --- | --- | --- |
| Forgejo | Open | Git |
| Woodpecker | Open | Build |
| Dagger | Copy runner environment variable when a local port exists | Sword |
| SSH | Copy command when a local port exists | Terminal |
| Navidrome | Copy URL | Music |
| Ente | Copy URL | Photos |
| Ente Storage | Copy URL | Storage |

Services are shown in three stable groups: open, copy command, then copy URL.
Publisher registry order is preserved within each group. Unknown services are
omitted until they have a built-in action.

URLs opened in a browser include a trailing slash. Navidrome, Ente Photos, and
Ente Storage copy their origin without a trailing slash because another app
consumes that value as a server address.

The Android Worklet sends the resolved action, icon, URL, and copy text through
the existing snapshot protocol. Kotlin renders those values and does not infer
behavior from service ids. The desktop runtime calls the same resolver before
sending its snapshot to the WebView.

SSH remains platform-aware. Desktop can copy a command when its subscriber has
an explicit local SSH port. Android currently exposes no local SSH listener, so
SSH is omitted there.

## Consequences

- Android and desktop share one tested behavior table.
- Adding a built-in service requires one policy entry plus platform icon
  rendering, not a new set of service-id branches.
- Registry metadata cannot make an unknown TCP service open a browser or copy
  unsafe text by accident.
- The map is a client presentation policy, not a new publisher protocol field.
