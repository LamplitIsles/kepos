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

Create publisher state using only the subscriber's public key:

```sh
npm run kepos -- setup publisher \
  --state ~/.local/state/kepos-neo/publisher \
  --display-name kosmos \
  --allow '<subscriber-public-key>' \
  --service ssh:SSH:22 \
  --service navidrome:Navidrome:4533
```

Print an existing publisher's public key without repeating or changing its
policy:

```sh
npm run kepos -- publisher key \
  --state ~/.local/state/kepos-neo/publisher
```

Run the publisher, then pin its public key on the subscriber:

```sh
npm run kepos -- publisher run \
  --state ~/.local/state/kepos-neo/publisher

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
allow = ["<subscriber-public-key>"]

[[publisher.services]]
id = "ssh"
name = "SSH"
target_port = 22

[[publisher.services]]
id = "navidrome"
name = "Navidrome"
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

Use `--config <path>` to select another file. A missing default file retains
state-based publisher policy and runtime defaults; a missing explicit file is
an error. An empty bootstrap array selects HyperDHT defaults.

When `[publisher]` exists, `display_name`, `allow`, and `services` form the
complete runtime policy. `enabled` controls desktop auto-start only. Identities
and the subscriber's pinned publisher contact always stay in the state
directory.

Create the publisher identity from that TOML without repeating its policy on
the command line:

```sh
npm run kepos -- setup publisher \
  --state ~/.local/state/kepos-neo/publisher
```

The headless publisher polls its selected TOML policy every second while it
runs. Valid changes apply without restarting the process, publisher identity, or
DHT listener. Removing a subscriber from the global allowlist disconnects only
that subscriber and denies reconnects; service-list, target, and service ACL
changes affect the next Home-registry request and newly opened service
channels, while existing service tunnels drain normally. Invalid or incomplete
TOML keeps the last valid policy and reports a reload failure. Desktop's **Add
device** approval is different: it updates both TOML and the running desktop
publisher.

Publisher-wide and service-specific allowlists fail closed:

- an empty publisher allowlist denies all subscribers;
- an omitted service allowlist inherits the publisher list;
- an explicit empty service allowlist denies that service to everyone;
- restricted services are omitted from registries returned to unauthorized
  subscribers.

Do not mix publisher setup flags with a configured `[publisher]` table. Kepos
rejects that ambiguous operation.

Without a `[publisher]` table, legacy state-owned policy can still be changed
while the publisher is stopped:

```sh
npm run kepos -- publisher set-allow \
  --state ~/.local/state/kepos-neo/publisher

npm run kepos -- publisher set-services \
  --state ~/.local/state/kepos-neo/publisher \
  --service ssh:SSH:22 \
  --service navidrome:Navidrome:4533
```

These commands fail instead of editing inactive state when TOML owns the
publisher policy. Neither command rotates the publisher key.

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
rollback. Sharing a device node never merges role keys, allowlists, publisher
pins, or state.

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
