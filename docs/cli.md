# CLI, identity, and configuration

The shipped CLI uses one canonical peer runtime. A peer has one persistent
identity and one configuration owner. Connection direction is selected per
configured peer; service provision, service consumption, and local bindings
are separate policy entries.

The commands are intentionally a hard cutover. `publisher`, `subscriber`, and
`device` command groups, their role-specific flags, old TOML tables, and old
state paths are not aliases. They fail as unknown commands/options. Every
admitted canonical peer must establish `kepos/peer-control/1`.

## Commands

```text
kepos setup peer       Create or validate one canonical identity and config
kepos peer key         Print one peer's public key
kepos peer status      Inspect canonical identity/config without starting DHT
kepos peer pair        Add or replace an explicitly trusted peer in TOML
kepos peer trust       Alias for peer pair
kepos peer convert     Offline-convert one selected legacy identity
kepos peer run         Start the canonical peer runtime
```

Every command accepts only the options shown in its section. `--config` and
`--state` paths are resolved before use and can point into a test-owned or
deployment-owned directory.

## Initialize one peer

```sh
npm run kepos -- setup peer \
  --state ~/.local/state/kepos-neo/peer \
  --config ~/.config/kepos/config.toml
```

`setup peer` creates `peer.json` when the state directory is absent and writes
an empty canonical config when the selected config is absent. Repeating it
validates and reuses the existing identity without rotating its key. Its only
output is:

```text
Peer key: <64 lowercase hexadecimal characters>
```

The private seed is never printed. `peer key` reads the same canonical state
without starting a network runtime:

```sh
npm run kepos -- peer key \
  --state ~/.local/state/kepos-neo/peer
```

## Canonical TOML

The file contains only network/gateway settings and three peer-oriented
collections. Keys in TOML are snake_case; the in-memory TypeScript API uses
camelCase.

```toml
[network]
bootstrap = ["bootstrap-one.example:49737", "bootstrap-two.example:49738"]
route = "auto"

[gateway]
port = 17480
# host = "127.0.0.1"
# domain = "kepos.internal"

[metrics]
host = "127.0.0.1"
port = 17481

[[peers]]
label = "mac"
public_key = "<mac-peer-public-key>"
connection = "accept"

[[peers]]
label = "phone"
public_key = "<phone-peer-public-key>"
connection = "dial"

[[services]]
id = "cua"
name = "CUA driver"
source = { unix_socket = "/run/user/1000/cua-driver.sock" }
allow = ["<nuc-peer-public-key>"]

[[services]]
id = "navidrome"
name = "Navidrome"
kind = "http"
source = { local_port = 4533 }
allow = ["<phone-peer-public-key>"]

[[services]]
id = "mac-cua"
name = "Mac CUA through NUC"
source = { peer = "mac", service = "cua" }
allow = ["<phone-peer-public-key>"]

[[bindings]]
peer = "mac"
service = "cua"
listen = { unix_socket = "/run/user/1000/kepos-cua.sock" }

[[bindings]]
peer = "phone"
service = "navidrome"
listen = { local_port = 0 }
```

The schema requires `peers`, `services`, and `bindings` arrays, including when
they are empty. A peer label and public key are unique. `connection` is either
`dial` or `accept`; there is no automatic election. A `dial` peer maintains a
connection and an `accept` peer waits for it. The authenticated public key,
not the label or a message claim, identifies the remote peer.

Each service has a lowercase ID, display name, `tcp`, `http`, or `udp` kind,
one source, and an immediate-peer `allow` list. A missing or empty `allow` list
denies the service. A source is exactly one of:

- `source = { local_port = 1234 }`, a fixed loopback TCP/UDP source;
- `source = { unix_socket = "/absolute/path.sock" }`, a byte-stream source;
- `source = { peer = "label-or-key", service = "upstream-id" }`, an explicit
  upstream service selected from one configured peer.

Service ports are fixed positive ports. Unix paths are absolute and bounded by
the host socket limit. A Unix source cannot provide a UDP service. A binding
owns a local loopback TCP port, local loopback UDP port, or Unix socket;
`local_port = 0` asks the OS for an ephemeral port. Omit `kind` for the
byte-stream/TCP default and use `kind = "udp"` for a forward UDP binding.
Remote peers cannot choose a local path, port, or target. Reverse UDP is not a
byte-stream capability.

An upstream service is not imported merely because a binding names it. To
republish it, create a new `[[services]]` entry with a peer/service source,
new `id`/`name`, and a downstream `allow` list. Each hop checks its immediate
peer independently. Keep source relationships acyclic; there is no graph
discovery, fallback peer, or end-user identity delegation.

`network.bootstrap` is an optional list of `host:port` DHT endpoints and
`network.route` is `auto` or `public`. `gateway` defaults to loopback and port
17480. `gateway.domain` adds an explicit suffix without removing the existing
`.localhost` convention.

The parser rejects unknown fields, old `[publisher]`/`[subscriber]` tables,
camelCase TOML spellings, incomplete source variants, unknown peer references,
duplicate IDs, duplicate labels/keys, and invalid endpoints. Serialization
round-trips through the same strict parser. Config saves are atomic and use
owner-only file permissions.

## Trust and pairing

For a known public key, add an explicit relationship with:

```sh
npm run kepos -- peer pair \
  --config ~/.config/kepos/config.toml \
  --label mac \
  --public-key '<mac-peer-public-key>' \
  --connection accept
```

`peer pair` edits only the canonical `peers` list. It does not add the key to
any service's `allow` list. Add or remove service grants separately and then
let the running peer reload the file. `peer trust` is the same command name
for operators who prefer trust terminology.

The desktop peer surface can create a short-lived pairing invitation for an
unknown candidate. Approval adds that candidate as an `accept` peer and
authorizes the authenticated connection, but it does not broaden any service
allowlist. Denial or expiry closes the candidate. Pairing is disabled by
configuration only when the host explicitly disables the desktop pairing
surface.

On a fresh Android install, select `Connect with key` and enter the other
peer's public key, or select `Scan invitation` for the QR invitation created by
the desktop/CLI pairing surface. Android also consumes a `kepos://pair?...`
deep link. The foreground Worklet writes the selected peer into its app-private
canonical `config.toml` and keeps the seed in app-private `peer.json`; the
host IPC uses `configure` for key entry and `pair` for an invitation. Admission
still does not add service grants, so the provider must list the Android public
key in each intended service's `allow` list. Android renders the canonical
service action metadata and opens supported HTTP actions or copies supported
endpoints; it does not expose a general config editor or reverse-service UI.

## Identity and deliberate cutover

Canonical state is a directory containing exactly:

```text
peer.json                 { "seed": "<private 32-byte seed>" }
```

The directory mode is `0700` and the file mode is `0600` on Unix-like hosts.
Runtime startup reads only this file, validates the derived HyperDHT public
key, and takes one sibling kernel lock. It never probes or migrates legacy
publisher/subscriber state and never starts two role runtimes for one device.

The intended cutover preserves NUC's current publisher public key and Mac's
active subscriber public key as their selected peer keys. If a device has both
old identities, choose one deliberately and rewrite every relevant peer pin
and immediate service grant; the two keys are not aliases.

The offline helper accepts either a selected old state directory or its exact
identity file:

```sh
npm run kepos -- peer convert \
  --source /backup/old-publisher \
  --destination /var/lib/kepos/peer \
  --expected-public-key '<retained-public-key>'
```

It recognizes one `publisher.json` seed or one validated
`client.identity.json` keypair, refuses a linked/ambiguous source, refuses an
existing destination or a destination inside the source, requires and
verifies the expected public key, and writes only private owner-only state.
It prints the resulting public key, never the seed or secret key. It is not a
startup migration.

Recommended operator order:

1. Stop and verify the old daemon is no longer using the selected identity.
2. Make a private backup outside both active state directories. Keep it until
   rollback is no longer needed.
3. Run `peer convert` with explicit paths and `--expected-public-key`; compare
   its public output with the deployment record.
4. Rewrite canonical `peers`, service `allow`, and upstream references using
   public keys or local labels. Do not copy an old subscriber contact into
   canonical state or broaden an ACL to compensate for a renamed peer.
5. Run `peer status`, inspect the counts, and start only `peer run` with the
   canonical state/config.
6. Verify an isolated service request and connection status before enabling
   host supervision.

Rollback is also deliberate: stop the canonical runtime, move its state aside,
restore the separately held backup, restore the previous config, and start the
old runtime. No active process should be killed by a cleanup script, and no
lock file should be manually deleted while a runtime may be alive.

## Run and reload

```sh
npm run kepos -- peer run \
  --state ~/.local/state/kepos-neo/peer \
  --config ~/.config/kepos/config.toml \
  --observations ndjson \
  --metrics-listen 127.0.0.1:17481
```

`--observations` is `human` by default or `ndjson`. The runtime acquires the
peer lock before starting DHT, gateway, or bindings. It reloads a valid
canonical config every second. Invalid changes leave the last valid config in
place and report an error. Valid peer direction changes close the old
connection; service, source, grant, and binding changes close affected active
channels and UDP flows. Existing bytes are never replayed after reconnect.

The command keeps bindings configured while a peer is offline and reports
them unavailable. A later canonical peer-control connection can serve new requests
after catalog and grant checks. A local Unix binding is removed only when its socket is
still the socket created by this runtime; an occupied or replaced foreign path
is preserved. Unix endpoints fail clearly on Windows.

`[metrics]` enables the existing Prometheus series on a separate
read-only `/metrics` listener. `--metrics-listen host:port` overrides the
configured listener for that process; port `0` selects an ephemeral port and
the effective URL appears in runtime status. The collector retains the
established `kepos_publisher_*` names and immediate-peer labels used by the
shipped Grafana artifact.

`peer status` is a stopped inspection of identity and configuration:

```sh
npm run kepos -- peer status \
  --state ~/.local/state/kepos-neo/peer \
  --config ~/.config/kepos/config.toml
```

The running desktop and diagnostics surfaces additionally show connection
direction, generation, service
availability, bindings, gateway, and pairing phase. Observations are
diagnostic, not a stable external API, and must not contain state files,
seeds, pairing tokens, full addresses, or secret material.

## Gateway and service operations

The HTTP gateway defaults to:

```text
http://<service-id>.localhost:17480/
```

`home.localhost` serves the authenticated machine-readable registry. The
gateway keeps service names unqualified. If more than one visible peer offers
the same TCP/HTTP service ID, the request fails with an ambiguity error until
one explicit `bindings` selection identifies the peer. Kepos never picks by
connection timing or reconnect order and does not invent peer-qualified URLs.

Raw TCP services use a binding:

```toml
[[bindings]]
peer = "nuc"
service = "ssh"
listen = { local_port = 2222 }
```

Forward UDP services use an explicit UDP binding. This opens a local loopback
datagram listener and maps each local flow to the authenticated remote service:

```toml
[[bindings]]
peer = "nuc"
service = "game"
kind = "udp"
listen = { local_port = 0 }
```

The selected local port is included in status. The target peer must be
configured with `connection = "dial"`; an accept-side UDP binding is retained
in configuration but reported unavailable, since reverse UDP is not provided.
Flow limits, datagram/fragment limits, authorization, revocation, source
outage, and reconnect are handled by the same canonical runtime; bytes or
replies from an old generation are not replayed. Reverse UDP remains explicitly
unsupported.

HTTP services use the existing HTTP/1.1 adapter only when `kind = "http"`.
Every request has caller-supplied `Authorization` fields removed and exactly
one immediate authenticated-peer header inserted:

```http
Authorization: Kepos <immediate-peer-public-key>
```

Ordinary request bodies, sequential keep-alive, and valid `ws://` WebSocket
upgrades are supported. HTTPS, `wss://`, HTTP/2, h2c, HTTP/3, CONNECT, and
non-WebSocket upgrades are not. A raw `tcp` stream receives no added header.

UDP services retain the existing fixed-target operation: IPv4 loopback only,
1,200-byte application datagrams, bounded 1,000-byte carrier fragments,
per-flow budgets, and no broadcast/multicast/arbitrary destination. Forward
UDP republication is supported when the upstream source is a UDP service. A
UDP service cannot be opened through the reverse byte-stream binding; it
returns an explicit unsupported result.

## Compatibility boundary

Every admitted canonical peer must establish `kepos/peer-control/1` before
Home, TCP, HTTP, UDP, or reverse byte-stream service operations are usable.
An incompatible peer is closed during protocol establishment; Kepos does not
silently open a second outbound connection or downgrade the canonical contract.

## Network and firewall boundary

Operators should admit the HyperDHT candidate listener range, normally
`49737-49741`, rather than only the first preferred port. The shared runtime
also uses an ephemeral DHT client socket and HyperDHT manages ephemeral UDX
connection sockets. The candidate listener range does not cover UDX connection sockets;
it does not guarantee the encrypted data path by itself.
