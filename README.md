# Kepos Neo

[![CI](https://github.com/tta-lab/kepos-neo/actions/workflows/check.yml/badge.svg?branch=main&event=push)](https://github.com/tta-lab/kepos-neo/actions/workflows/check.yml)
[![codecov](https://codecov.io/github/tta-lab/kepos-neo/graph/badge.svg?branch=main)](https://app.codecov.io/github/tta-lab/kepos-neo)

Kepos Neo exposes a publisher's local Home page and configured TCP services to
allowlisted subscribers. One persistent encrypted HyperDHT connection carries
independent Protomux channels for Home, SSH, Navidrome, and other services.

## Requirements

- Node.js 22
- npm 10

Desktop development pins the current `tta-lab` Bare UI forks as Git
submodules. Initialize them before installing dependencies:

```sh
git submodule update --init --recursive
npm ci
```

Use the canonical `kepos` CLI below to create publisher and subscriber state.

## Nix publisher

The flake exports a Linux CLI package and a Home Manager publisher module. A
consumer flake can follow its existing Nixpkgs and Home Manager inputs:

```nix
inputs.kepos-neo = {
  url = "github:tta-lab/kepos-neo";
  inputs.nixpkgs.follows = "nixpkgs";
  inputs.home-manager.follows = "home-manager";
};
```

Import and configure the module in a Home Manager configuration:

```nix
{
  inputs,
  ...
}: {
  imports = [inputs.kepos-neo.homeManagerModules.default];

  services.kepos.publisher = {
    enable = true;
    bootstrap = ["47.94.213.63:49737"];
    displayName = "kosmos";
    allow = ["<subscriber-public-key>"];
    services = {
      ssh = {
        name = "SSH";
        targetPort = 22;
      };
      navidrome = {
        name = "Navidrome";
        targetPort = 4533;
      };
    };
  };
}
```

On first start, the user service creates the publisher identity in `stateDir`,
which defaults to `$XDG_STATE_HOME/kepos-neo/publisher`. If complete publisher
state already exists, it is reused without rotation. A partial state directory
fails closed. Bootstrap endpoints, allowlist, display name, and services are
generated as public TOML policy; private keys never enter the Nix store. Empty
`allow` denies all subscribers, empty `services` publishes Home only, and empty
`bootstrap` uses HyperDHT defaults.

The package and CLI app are also available directly:

```sh
nix run github:tta-lab/kepos-neo -- --help
```

## Container image

The Nix flake builds the same headless Linux CLI as a non-root container image:

```sh
nix build .#container-image
docker load < result
docker run --rm ghcr.io/tta-lab/kepos-neo:local --help
```

Every push to `main` publishes the `linux/amd64` image to GHCR with both
`main` and immutable `sha-<git-commit>` tags. Deployments should pin the digest
printed in the GitHub Actions summary:

```text
ghcr.io/tta-lab/kepos-neo@sha256:<digest>
```

GHCR creates a new package as private. After its first publication, an
organization owner must make `kepos-neo` public once so a fresh cluster can
pull it without registry credentials.

## Identity and keys

Every publisher and subscriber has a cryptographic public/private key pair.
The long hexadecimal key shown by the CLI or Android app is the **public key**,
not a bearer token:

- share a subscriber public key with its publisher so it can be allowlisted;
- pin the publisher public key on each subscriber so it connects to the intended
  publisher;
- keep the subscriber secret key and publisher seed on the device that created
  them. They prove ownership of the corresponding public key and must never be
  copied to another device, committed, or placed in logs.

CLI identities live inside the selected `--state` directory. Android stores its
subscriber identity in app-private storage. Each installation must generate its
own subscriber identity; copying a secret identity would make two installations
impersonate the same subscriber. Public keys may be copied and displayed freely.

## Android subscriber

The sideload-only Android app is a subscriber-only arm64 client. A Kotlin foreground service
owns one Bare Worklet, and that Worklet runs the same HyperDHT/Protomux
subscriber core as the CLI. It does not install a VPN, TUN interface, or system
DNS service.

After setup, the dark service home reads the publisher's real Registry and
shows its display name and published services. It hides the synthetic Home
entry: known web services open through their `*.localhost` URL, Navidrome copies
its URL for first-time Navic setup, and unknown or TCP services show a usage note. Publisher
keys, diagnostics, reconfiguration, and runtime controls live under Settings.
During reconnect, the last known service list stays visible but disabled.

Build or install the debug app:

```sh
npm run android:assemble
npm run android:install
```

`android:install` uses `adb install -r`: it installs Kepos Neo when absent and
updates the existing app while preserving app-private state, including the
subscriber identity. Set `ANDROID_SERIAL` when more than one device is
connected. A signing mismatch fails closed; the command never uninstalls the
existing app or clears its data.

Run the physical-device lifecycle gate separately:

```sh
npm run android:device-check
```

The gate targets the isolated package `io.github.ttalab.kepos.devicetest` on
ports 18480 and 18481. Android Gradle Plugin cleanup may uninstall that test
package after the run, but it cannot replace, reconfigure, or remove the
installed `io.github.ttalab.kepos` app and its state.

The app generates its subscriber identity in app-private storage. Add the
displayed public key to the publisher allowlist, paste the publisher public key
into the app, and keep the foreground service running. An explicit Stop remains
in effect when the Activity is reopened; Start clears that choice. The Navidrome card copies
the canonical local URL:

```text
http://navidrome.localhost:17480/
```

The runtime also keeps `127.0.0.1:17481` as an internal compatibility listener
for clients that cannot resolve `*.localhost`; it is not the product-facing
address. Both routes use the same publisher connection. This is not yet a Play
Store release, and foreground-service policy remains unresolved.

## Persistent multiplex CLI

The canonical CLI keeps one encrypted subscriber connection open to one
publisher. Home, SSH, Navidrome, and other configured TCP services use
independent Protomux channels on that connection. The publisher accepts
several subscribers through one shared allowlist.

Create the subscriber identity on the subscriber:

```sh
npm run kepos -- setup subscriber \
  --state ~/.local/state/kepos-neo/subscriber
```

Create publisher state using only the subscriber's public key:

```sh
npm run kepos -- setup publisher \
  --state ~/.local/state/kepos-neo/publisher \
  --display-name kosmos \
  --allow <subscriber-public-key> \
  --service ssh:SSH:22 \
  --service navidrome:Navidrome:4533
```

Run the publisher, then pin its one public key on the subscriber:

```sh
npm run kepos -- publisher run \
  --state ~/.local/state/kepos-neo/publisher

npm run kepos -- subscriber set-publisher \
  --state ~/.local/state/kepos-neo/subscriber \
  --label kosmos \
  --publisher-key <publisher-public-key>
```

Publisher setup and both run commands read persistent CLI settings from
`$XDG_CONFIG_HOME/kepos/config.toml`, or `~/.config/kepos/config.toml` when
`XDG_CONFIG_HOME` is unset:

```toml
[network]
bootstrap = [
  "47.94.213.63:49737",
  "203.91.75.19:49738",
]

[publisher]
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

[subscriber]
gateway_port = 17480
route = "auto"

[[subscriber.services]]
id = "ssh"
local_port = 2222
```

Use `--config <path>` to select another file. A missing default file retains
the existing state-based publisher policy and runtime defaults; a missing
explicit file is an error. An empty `network.bootstrap` array selects
HyperDHT's built-in bootstrap set. An empty publisher allowlist denies every
subscriber, while empty publisher or subscriber service arrays mean Home-only
publishing or no raw TCP listeners respectively.

When `[publisher]` exists, it is the complete runtime publisher policy and all
three fields (`display_name`, `allow`, and `services`) are required. Existing
installations without that table continue to read display name, allowlist, and
services from publisher state. Publisher and subscriber private keys, plus the
subscriber's paired publisher contact, always remain in the state directory.

`setup publisher` can create the publisher identity directly from this TOML:

```sh
npm run kepos -- setup publisher \
  --state ~/.local/state/kepos-neo/publisher
```

Do not mix publisher policy flags with a configured `[publisher]` table. The
CLI rejects that ambiguous setup instead of writing inactive policy into state.

The run commands also accept explicit options which replace the matching TOML
setting for that invocation. For example, repeated `--bootstrap host:port`
options replace the configured bootstrap list:

```sh
npm run kepos -- subscriber run \
  --state ~/.local/state/kepos-neo/subscriber \
  --bootstrap 47.94.213.63:49737 \
  --bootstrap 203.91.75.19:49738
```

Bootstrap nodes only help the process enter the public DHT. They do not relay
the established stream, grant access, or change the pinned publisher key.

HyperDHT crawling, geographic reports, candidate validation, and regional
bootstrap benchmarks live in
[`tta-lab/hyperdht-observatory`](https://github.com/tta-lab/hyperdht-observatory).
Kepos does not fetch or trust Observatory output at runtime; operators review
and put chosen endpoints in the TOML config or pass them explicitly with
`--bootstrap`.

Run one local HTTP gateway plus any raw TCP listeners:

```sh
npm run kepos -- subscriber run \
  --state ~/.local/state/kepos-neo/subscriber \
  --service ssh:2222

ssh -p 2222 <user>@127.0.0.1
```

The HTTP gateway listens on `127.0.0.1:17480` by default. Every published HTTP
service is available through the same listener and one persistent publisher
connection:

```text
http://home.localhost:17480/
http://navidrome.localhost:17480/
```

The gateway maps the request hostname to a Protomux service ID. HTTP services
do not need a subscriber `--service` option or a separate local process.
`--service id:local-port` remains as a one-run override for raw TCP services
such as SSH. If 17480 is occupied, select another gateway port:

Home treats the reserved `ssh` service as raw TCP. Its local port belongs to
the subscriber configuration, so the publisher Home does not guess or display
an SSH command. Every other published service is presented as an HTTP link on
the current gateway port.

```sh
npm run kepos -- subscriber run \
  --state ~/.local/state/kepos-neo/subscriber \
  --gateway-port 18080 \
  --service ssh:2222
```

Subscriber route mode defaults to `auto`, which permits HyperDHT's LAN-local
shortcut. Add `--route public` to disable only that shortcut when comparing a
non-local DHT path. It does not force a relay, choose a fixed Internet route,
or promise stable latency. Add `--observations ndjson` for structured events;
status remains on stderr so stdout stays valid NDJSON.

Use `outerId` to correlate connection and channel events. Several
`channel.open` events with one `outerId` are several TCP services sharing one
persistent connection, not several DHT handshakes. Transport snapshots are
captured again on `channel.open-ok`, `channel.open-error`, and `channel.close`.
Their `udx` fields include live RTT, congestion window, in-flight packet,
timeout, retransmit, recovery, and byte/packet counters. These are sanitized
diagnostics whose shape may change; do not treat them as a stable API or copy
state files into logs.

When HyperDHT attempts a punch, `outer.holepunch` records the local and remote
firewall classes (`open`, `consistent`, `random`, or `unknown`) and only the
number of candidate addresses. Connection and close events also include
cumulative DHT punch and relay counters. No candidate IP addresses are logged.

The command prints the local Home URL immediately and keeps the gateway and raw
TCP listeners bound while the publisher is unavailable. Connection attempts
continue in the background instead of terminating the CLI.

New peers also negotiate one `kepos/control/1` heartbeat channel on the existing
encrypted outer connection. After a healthy pong, the subscriber waits 15
seconds, allows 10 seconds for a reply, then retries once with another 10-second
deadline. A silent path is therefore replaced after about 35 seconds even when
HyperDHT has not emitted `close` or `error`. `outer.unhealthy`, `outer.closed`,
and `outer.restored` observations describe that recovery without logging every
normal ping.

The publisher permits only one current outer connection for each authenticated
subscriber public key. A new control-ready outer replaces the older one; a
non-current candidate cannot open services. The CLI also locks each subscriber
state directory while `subscriber run` owns its secret identity. Different
subscriber installations must use different identities.

Deploy the publisher before subscribers when introducing the control protocol.
An older publisher remains compatible, but it does not provide the bounded
heartbeat recovery or newest-connection replacement. Reconnecting preserves
localhost ports and identity; active TCP streams still break and must be retried
by the client.

With TOML-owned publisher policy, revoke every subscriber without rotating the
publisher key by setting the allowlist to empty and restarting the publisher:

```toml
[publisher]
display_name = "kosmos"
allow = []
services = []
```

When `[publisher]` is absent, legacy state policy remains available through the
mutation commands:

```sh
npm run kepos -- publisher set-allow \
  --state ~/.local/state/kepos-neo/publisher
```

These commands fail clearly instead of editing inactive state when
`[publisher]` exists. For a state-owned publisher, allowlist and service changes
edit stopped state and take effect on the next `publisher run`. Replace
services without rotating the publisher key:

```sh
npm run kepos -- publisher set-services \
  --state ~/.local/state/kepos-neo/publisher \
  --service ssh:SSH:22 \
  --service navidrome:Navidrome:4533
```

The historical evidence in `docs/evidence/mac-kosmos-ssh-dogfood.md` records
the tested Mac-to-kosmos path and the commands used at the time.

Home also exposes a bounded download endpoint for transport checks:

```text
GET /.well-known/kepos/benchmark?bytes=16777216
```

`bytes` must be from 1 through 67108864. The response is streamed, is not
cached, and should be used only for diagnostics.
