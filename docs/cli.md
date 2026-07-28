# CLI, identity, and configuration

The Kepos CLI can run a publisher, a subscriber, or both as separate processes.
One subscriber keeps one encrypted connection open to one publisher. Registry,
control, HTTP, SSH, and other services use independent Protomux channels on
that connection.

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

The headless publisher reads TOML policy when it starts. After editing the
allowlist or services, restart `publisher run` before treating the change as
active. Restarting closes existing service streams, so their clients must
reconnect. Desktop's **Add device** approval is different: it updates both TOML
and the running desktop publisher.

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

The CLI locks a subscriber state directory while it owns that identity.
Different installations must use different subscriber identities.

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

These diagnostics are sanitized but their shape is not a stable API. Never
copy state files into logs.

HyperDHT crawling, regional bootstrap measurements, and candidate validation
live in
[`tta-lab/hyperdht-observatory`](https://github.com/tta-lab/hyperdht-observatory).
Kepos never fetches or trusts Observatory output at runtime. Operators choose
and configure endpoints themselves.

The bounded transport endpoint is available for diagnostics:

```text
GET /.well-known/kepos/benchmark?bytes=16777216
```

`bytes` must be between 1 and 67108864. The response is streamed and not
cached.
