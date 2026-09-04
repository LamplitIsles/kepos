# CLI, identity, and configuration

The Kepos CLI can run a publisher, a subscriber, or both roles in one device
process. Standalone role commands remain available when the roles need separate
network policy or lifecycles. One subscriber keeps one encrypted connection
open to one publisher. Registry, control, HTTP, SSH, and other services use
independent Protomux channels on that connection.

## Create identities

Create a subscriber identity:

```sh
npm run kepos -- setup subscriber \
  --state ~/.local/state/kepos-neo/subscriber
```

Create the publisher's seed-derived identity:

```sh
npm run kepos -- setup publisher \
  --state ~/.local/state/kepos-neo/publisher
```

Publisher setup accepts only `--state`. It creates one strict
`publisher.json` containing the seed, reuses a valid identity without key
rotation, and rejects partial, extra, or malformed state. Publisher display
name, subscriber devices, services, and service allowlists belong in TOML.

Print an existing publisher's public key without repeating or changing its
policy:

```sh
npm run kepos -- publisher key \
  --state ~/.local/state/kepos-neo/publisher
```

Run the publisher, then pin its public key on the subscriber:

```sh
npm run kepos -- publisher run \
  --state ~/.local/state/kepos-neo/publisher \
  --config ~/.config/kepos/config.toml

npm run kepos -- subscriber set-publisher \
  --state ~/.local/state/kepos-neo/subscriber \
  --label kosmos \
  --publisher-key '<publisher-public-key>'
```

## Shared TOML policy

The CLI and desktop read `$XDG_CONFIG_HOME/kepos/config.toml`, or
`~/.config/kepos/config.toml` when `XDG_CONFIG_HOME` is unset:

```toml
[network]
bootstrap = [
  "bootstrap-one.example:49737",
  "bootstrap-two.example:49738",
]

[publisher]
enabled = false
display_name = "kosmos"
subscribers = [
  { label = "nuc", public_key = "<subscriber-public-key>" },
]

[[publisher.services]]
id = "ssh"
name = "SSH"
target_port = 22

[[publisher.services]]
id = "navidrome"
name = "Navidrome"
kind = "http"
target_port = 4533
allow = ["<subscriber-public-key>"]

[subscriber]
enabled = true
gateway_port = 17480
route = "auto"

[[subscriber.services]]
id = "ssh"
local_port = 2222
```

Use `--config <path>` to select another file. A publisher run, or a
publisher-enabled `device run`, requires that the selected/default file exists
and contains a complete `[publisher]` table. Subscriber-only commands remain
independent of publisher policy. An empty bootstrap array selects HyperDHT
defaults.

When `[publisher]` exists, `display_name`, `subscribers`, and `services` form the
complete runtime policy. `enabled` controls desktop auto-start only. Identities
and the subscriber's pinned publisher contact always stay in the state
directory.

Create the publisher identity independently with its state path; setup reads
only `--state`. The TOML supplies the publisher policy when the runtime starts:

```sh
npm run kepos -- setup publisher \
  --state ~/.local/state/kepos-neo/publisher
```

The headless publisher polls its selected TOML policy every second while it
runs. Valid changes apply without restarting the process, publisher identity, or
DHT listener. Removing a subscriber device from the policy disconnects only
that subscriber and denies reconnects; service-list, target, and service ACL
changes affect the next Home-registry request and newly opened service
channels, while existing service tunnels drain normally. Invalid or incomplete
TOML keeps the last valid policy and reports a reload failure. Desktop's **Add
device** approval is different: it updates both TOML and the running desktop
publisher.

Publisher subscriber-device policy and service-specific allowlists fail closed:

- an empty publisher `subscribers` list denies all devices;
- an omitted service allowlist inherits the publisher subscriber-device policy;
- an explicit empty service allowlist denies that service to everyone;
- restricted services are omitted from registries returned to unauthorized
  subscribers.

There are no publisher state-policy mutation commands. Edit the TOML
`display_name`, `subscribers`, `services`, and `allow` values instead. A
publisher state directory contains identity only; the separate service
manifest and state policy snapshot are not read or migrated.

## Publisher metrics and dashboard

Publisher-capable commands expose metrics only when explicitly requested:

```sh
npm run kepos -- publisher run \
  --state ~/.local/state/kepos-neo/publisher \
  --metrics-listen 127.0.0.1:9464

npm run kepos -- device run \
  --publisher-state ~/.local/state/kepos-neo/publisher \
  --metrics-listen 127.0.0.1:9464
```

Scrape `GET http://127.0.0.1:9464/metrics`. No endpoint is started when the
option is omitted; other paths and methods return no metric exposition. The
listener is part of publisher shutdown and binds only where the deployment's
network policy permits.

The seven stable metric names are:

- `kepos_publisher_subscriber_connected` — `1` while a configured subscriber
  device has the current connection, otherwise `0`.
- `kepos_publisher_subscriber_last_connected_timestamp_seconds` — the most
  recent successful activation time, or `0` before the first connection.
- `kepos_publisher_subscriber_connection_bytes` — current-connection payload
  bytes, reset on replacement or close.
- `kepos_publisher_subscriber_bytes_total` — monotonic process-lifetime
  subscriber payload counters.
- `kepos_publisher_service_authorized` — the configured device/service ACL
  cross-product, including explicit zeroes.
- `kepos_publisher_service_active_channels` — live channels per device and
  published service, including idle zeroes.
- `kepos_publisher_service_bytes_total` — monotonic service payload counters.

Labels are deliberately bounded to `subscriber_label`, the first 16 lowercase
hex characters of the public key as `subscriber_id`, `service`, and (where
applicable) `direction`. Direction values are `publisher_to_subscriber` and
`subscriber_to_publisher`. Full keys, addresses, outer IDs, and channel IDs
never appear in the metric labels. Service counters count payload bytes at the
mux data path; subscriber counters aggregate those same service flows.

The dashboard is dependency-free Jsonnet owned by Kepos in
`grafana/kepos-publisher-observability.jsonnet` and
`grafana/traffic-console.libsonnet`. Build the owned artifact with
`nix build .#grafana-dashboard`; it installs
`share/kepos/grafana/kepos-publisher-observability.json`. The dashboard uses a
selectable Prometheus datasource, shows connected devices and every authorized
service before rolling `rate` charts, and keeps offline devices in a muted final
table.

## HTTP service device authentication

Use `kind = "http"` (or the final `:http` service-declaration segment) only
for a plaintext HTTP/1.1 target. It is a publisher-side authentication adapter,
not a generic TLS terminator or protocol tunnel.

For every HTTP request, including the opening request of a `ws://` WebSocket
Upgrade, Kepos removes all caller-supplied `Authorization` fields and forwards
exactly one target-facing field:

```http
Authorization: Kepos <subscriber-public-key>
```

`<subscriber-public-key>` is the authenticated subscriber's canonical
lowercase 64-hex-character public key. It identifies a device, not a person or
a secret bearer token. A target can authorize it with small HTTP middleware or
an Upgrade-handler check. Caller-supplied Bearer, Basic, and other
`Authorization` values are intentionally not forwarded. Normal target
responses, including `401` with `WWW-Authenticate: Kepos` and `403`, pass
through unchanged.

The adapter supports ordinary HTTP/1.1 requests (including bodies, chunked
requests, and sequential keep-alive requests) and `ws://`. A target's valid
`101 Switching Protocols` response switches the connection to opaque WebSocket
bytes; a rejected upgrade remains an ordinary HTTP response. HTTPS/TLS,
`wss://`, HTTP/2 and h2c, HTTP/3, CONNECT, and non-WebSocket upgrades are not
supported. Malformed or ambiguous framing, and request or inspected Upgrade
response heads larger than 16 KiB, fail closed instead of becoming an opaque
identity-bearing stream.

The header is trustworthy only at its intended private publisher ingress:
anything that can connect to the target without passing through Kepos can forge
`Authorization: Kepos ...`. Keep the target private and rely on the header only
when its traffic must pass through the publisher adapter. The subscriber gateway
binds to loopback by default. Binding it to a non-loopback address such as
`0.0.0.0` delegates that subscriber device's Kepos capability to every reachable
LAN client; the client-to-gateway HTTP leg is plaintext unless the deployment
protects it separately.

## Run both roles as one device

A dual-role host can keep the two state directories and identities while
sharing one device-owned HyperDHT node and UDP transport:

```sh
npm run kepos -- device run \
  --publisher-state ~/.local/state/kepos-neo/publisher \
  --subscriber-state ~/.local/state/kepos-neo/subscriber \
  --subscriber-service ssh:2222
```

The state flags select the roles explicitly. The TOML `enabled` fields control
Desktop auto-start and do not silently add a role to `device run`. The command
reads publisher policy and subscriber gateway, route, and service defaults from
the shared TOML. Repeated `--subscriber-service id:local-port` options replace
configured subscriber bindings for that invocation.

`--bootstrap host:port` is device-wide for this command and replaces
`[network].bootstrap` once for both roles. Startup is atomic: if either selected
role cannot start, Kepos stops any role that did start, destroys the shared
node, releases both state locks, and exits for the host supervisor to retry.
The publisher lock is acquired before the subscriber lock; shutdown releases
them in the opposite order.

`publisher run` and `subscriber run` still create and own independent DHT nodes.
Use them for single-role hosts, separate supervisors, transport isolation, or
rollback. Sharing a device node never merges role keys, subscriber-device
policies, publisher pins, or state.

## Local services

Run the subscriber with a raw SSH listener:

```sh
npm run kepos -- subscriber run \
  --state ~/.local/state/kepos-neo/subscriber \
  --service ssh:2222

ssh -p 2222 user@127.0.0.1
```

The HTTP gateway listens on `127.0.0.1:17480` by default. Published HTTP
services share that listener:

```text
http://navidrome.localhost:17480/
```

Kepos reserves `home` for machine-readable discovery:

```text
http://home.localhost:17480/.well-known/kepos/services.json
```

The root Home path does not serve a human page. `ssh` remains a raw TCP service
with an explicit subscriber-side local port.

## Runtime behavior

The gateway and raw listeners remain bound while the publisher is unavailable.
Reconnection happens in the background. Existing TCP streams still break and
must be retried by their clients.

Peers negotiate a `kepos/control/1` heartbeat on the existing connection. A
silent path is replaced after about 35 seconds: 15 seconds before a probe, a
10-second deadline, then one retry with another 10-second deadline. A new
control-ready connection replaces the previous connection for the same
subscriber public key.

The CLI locks a subscriber state directory while it owns that identity. The
publisher and `device run` commands take the matching publisher lock too.
Different installations must use different identities.

## Route and observations

Route mode `auto` permits HyperDHT's LAN-local shortcut. `--route public`
disables only that shortcut for comparisons; it does not force a relay or
promise a fixed Internet path.

Explicit `--bootstrap host:port` options replace the configured bootstrap list
for one invocation. Bootstrap nodes help the peer enter the DHT; they do not
relay the established stream, authorize a peer, or change the pinned publisher
key.

Use `--observations ndjson` for structured events. Status remains on stderr so
stdout stays valid NDJSON. `outerId` correlates one connection with its service
channels. Transport snapshots include RTT, congestion window, retransmit,
recovery, and byte counters. Hole-punch observations contain firewall classes
and candidate counts, never candidate IP addresses.

When both roles share a device node, HyperDHT counters describe that node as a
whole. They cannot be assigned exactly to publisher or subscriber traffic even
when an observation was emitted by one role. Role-specific events are recorded
above the DHT layer.

Operators should admit HyperDHT's UDP candidate listener range, normally
`49737-49741`, rather than only the preferred first port. A shared node normally
selects one listener from that range, but `dht-rpc` also uses an ephemeral DHT
client socket and HyperDHT manages ephemeral UDX connection sockets. The
candidate listener range does not cover those UDX connection sockets and does
not guarantee the encrypted data path by itself.

These diagnostics are sanitized but their shape is not a stable API. Never
copy state files into logs.

HyperDHT crawling, regional bootstrap measurements, and candidate validation
live in
[`LamplitIsles/hyperdht-observatory`](https://github.com/LamplitIsles/hyperdht-observatory).
Kepos never fetches or trusts Observatory output at runtime. Operators choose
and configure endpoints themselves.

The bounded transport endpoint is available for diagnostics:

```text
GET /.well-known/kepos/benchmark?bytes=16777216
```

`bytes` must be between 1 and 67108864. The response is streamed and not
cached.
