# ADR 0005: Centralize built-in service presentation

Status: Accepted (historical role-specific presentation model; canonical
peer surface superseded by ADR 0013 and `src/services/presentation.ts`)

Date: 2026-07-24

Amended: 2026-07-28 to add the registry HTTP fallback and dedicated
BookOrbit/Mihomo presentations.

## Context

The role-specific resolver described here was superseded by the canonical
peer service snapshot in ADR 0013. `src/runtime/service-handlers.ts` is no
longer a production module; the remaining text records the earlier
presentation decision and its durable service-action intent. The implemented
owner is now `src/services/presentation.ts`, which carries the same action
policy through canonical peer status to desktop and Android.

The publisher registry describes service identity and transport, but it does
not say whether a client should open a service, copy an address, copy a command,
or only show it. Android and desktop need the same product behavior without
duplicating service-id checks in Kotlin and WebView code.

## Historical decision

`src/runtime/service-handlers.ts` is the single source of truth for built-in
service presentation. It maps a service id to its action, icon, and sort group,
then produces the full client-facing service list.

The current policy is:

| Service | Action | Icon |
| --- | --- | --- |
| BookOrbit | Open | Book |
| Forgejo | Open | Git |
| Mihomo Dashboard | Open | Dashboard |
| Woodpecker | Open | Build |
| Dagger | Copy runner environment variable when a local port exists | Sword |
| Mihomo | Copy local SOCKS5 URL when a local port exists | Network |
| SSH | Copy command when a local port exists | Terminal |
| Navidrome | Copy URL | Music |
| Ente | Copy URL | Photos |
| Ente Storage | Copy URL | Storage |

Services are shown in three stable groups: open, local-port actions, then copy
URL. Publisher registry order is preserved within each group. An unknown
service uses the open group with a Web icon and
`http://<service-id>.localhost:<gateway-port>/`; `home` remains hidden.

URLs opened in a browser include a trailing slash. Navidrome, Ente Photos, and
Ente Storage copy their origin without a trailing slash because another app
consumes that value as a server address.

The Android Worklet sends the resolved action, icon, URL, and copy text through
the existing snapshot protocol. Kotlin renders those values and does not infer
behavior from service ids. The desktop runtime calls the same resolver before
sending its snapshot to the WebView.

## Current superseding contract

`src/services/presentation.ts` is the single source of truth for built-in
service presentation in the canonical peer runtime. It retains the action,
icon, URL, and endpoint/command mapping above, adds explicit UDP endpoint
presentation for hosts that support forward UDP bindings, and gives unknown raw
TCP services a copy-endpoint action instead of a blind HTTP URL. Canonical
status carries the resulting metadata to both shipped clients. Android filters
UDP entries because its supported client boundary has no local UDP operation.
Peer identity/state ownership is defined by
[ADR 0013](0013-separate-connection-roles-from-service-roles.md); the older
publisher identity/state decision in
[ADR 0010](0010-publisher-identity-state-and-toml-policy.md) remains historical
and is not another runtime or configuration source.

SSH remains platform-aware. Desktop can copy a command when its subscriber has
an explicit local SSH port. Android currently exposes no local SSH listener, so
SSH is omitted there.

## Consequences

- Android and desktop share one tested behavior table.
- Adding a built-in service requires one policy entry plus platform icon
  rendering, not a new set of service-id branches.
- Unknown registry services get only the fixed HTTP gateway fallback; registry
  metadata cannot supply a URL, command, or copy text.
- The map is a client presentation policy, not a new publisher protocol field.
