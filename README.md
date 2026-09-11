# Kepos

[![CI](https://github.com/LamplitIsles/kepos/actions/workflows/check.yml/badge.svg?branch=main&event=push)](https://github.com/LamplitIsles/kepos/actions/workflows/check.yml)
[![codecov](https://codecov.io/github/LamplitIsles/kepos/graph/badge.svg?branch=main)](https://app.codecov.io/github/LamplitIsles/kepos)

**Share a service, not a network.**

Kepos gives trusted devices access to selected services without exposing a
public service port or joining every device to a virtual subnet. Every runtime
has one persistent peer identity. A peer can dial one configured relationship,
accept another, provide local services, consume explicitly granted services,
and bind those services to local endpoints.

The canonical configuration keeps those concerns separate:

- `peers` names authenticated peers and says whether this runtime dials or
  accepts each relationship;
- `services` publishes a fixed loopback TCP/UDP port, Unix socket, or explicitly
  selected peer/service source with an immediate-peer `allow` list;
- `bindings` owns local TCP/UDP or Unix entry points for services on another
  peer. Set `kind = "udp"` for a datagram binding; its listener is always a
  local loopback port.

Service republication is explicit. A peer/service source gets a new local
service ID and its own downstream allowlist. A binding by itself never
publishes the imported service and never delegates the upstream identity.

Kepos carries raw TCP byte streams, opt-in HTTP/1.1 service traffic, and
bounded fixed-target UDP datagrams through an authenticated HyperDHT/UDX
connection. The outer connection is encrypted with Noise SecretStream and
multiplexed with Protomux. UDP services retain datagram boundaries, cap
application payloads at 1,200 bytes, and do not provide broadcast, multicast,
arbitrary destinations, or reliable delivery. See the [CLI and configuration
contract](docs/cli.md) and [transport boundary](docs/network-transport-and-compatibility.md).

> Kepos is a developer preview. Android APKs, Apple Silicon macOS ZIPs, and
> Windows x64 portable ZIPs are available for direct download. Android is
> sideload-only; macOS is ad-hoc signed and not notarized; Windows is not
> Authenticode-signed and may trigger SmartScreen.

## Start here

The **[Kepos user documentation](https://kepos.guion.io/docs/)** is the
primary installation and end-user guide. Repository operators and contributors
can continue with:

- [CLI, identity, and configuration](docs/cli.md)
- [Developer architecture](docs/architecture.md)
- [Nix, container, and Kubernetes deployment](docs/deployment.md)
- [Network transport and compatibility](docs/network-transport-and-compatibility.md)
- [Platform guides](docs/platforms/)
- [DeepSeek Harness integration](docs/integrations/deepseek-harness.md)

## Minimal peer configuration

Initialize one canonical identity and an empty config:

```sh
npm run kepos -- setup peer \
  --state ~/.local/state/kepos-neo/peer \
  --config ~/.config/kepos/config.toml
```

The command prints only the public key. Add the other peer's public key and
the services that should be visible to it:

```toml
[gateway]
port = 17480

[[peers]]
label = "mac"
public_key = "<mac-peer-public-key>"
connection = "accept"

[[services]]
id = "cua"
name = "CUA driver"
source = { unix_socket = "/run/user/1000/cua-driver.sock" }
allow = ["<nuc-peer-public-key>"]

[[bindings]]
peer = "mac"
service = "cua"
listen = { unix_socket = "/run/user/1000/kepos-cua.sock" }
```

Use `connection = "dial"` on the side that must establish the connection.
The service direction is independent: once the connection exists, either
authorized peer can open a byte-stream service if both ends support the peer
capability. A legacy client can still use the existing server-side TCP, HTTP,
and UDP operations, but it cannot provide reverse services.

Start the runtime with:

```sh
npm run kepos -- peer run \
  --state ~/.local/state/kepos-neo/peer \
  --config ~/.config/kepos/config.toml
```

Inspect the identity or stopped configuration without starting the network:

```sh
npm run kepos -- peer key --state ~/.local/state/kepos-neo/peer
npm run kepos -- peer status --state ~/.local/state/kepos-neo/peer \
  --config ~/.config/kepos/config.toml
```

The gateway retains the unqualified service convention:
`http://<service-id>.localhost:17480/`. When several visible peers provide
the same HTTP service ID, Kepos reports an ambiguity; configure one explicit
binding instead of relying on timing or peer order.

The canonical runtime also preserves the existing Prometheus series and
service-action mapping. Add `[metrics] host = "127.0.0.1"` and a `port` to the
config, or pass `--metrics-listen host:port` to `peer run`; the read-only
endpoint is reported in peer status. HTTP services open their unqualified
`.localhost` URL, while raw TCP, Unix, and UDP services expose a copyable
endpoint or platform-specific action. Reverse UDP remains unsupported.

## Identity and cutover

Peer state is one private, owner-only `peer.json` containing a seed. Startup
reads only that canonical directory; it does not probe publisher/subscriber
state, contact files, old TOML tables, or a fallback runtime. `setup peer` is
idempotent and never rotates an existing key.

For a deliberate deployment cutover, retain NUC's existing publisher public
key as its peer identity and Mac's active subscriber public key as its peer
identity. Back up the old state outside the active runtime directory, stop
the old daemon, run `peer convert` with explicit source and destination paths,
verify the printed public key, rewrite peer references and immediate service
grants, then start only `peer run`. The conversion helper refuses overwrite,
rejects ambiguous or linked sources, writes private state with owner-only
permissions, and never prints private material. Rollback means stopping the
new runtime and restoring the separately held backup; there is no runtime
fallback or dual-identity alias.

See [CLI, identity, and configuration](docs/cli.md#identity-and-deliberate-cutover)
for the complete ordering and [deployment](docs/deployment.md) for supervised
operation. This repository has not converted real NUC or Mac state.

## Supported surfaces

| Surface | Canonical boundary |
| --- | --- |
| Android | One canonical peer runtime in the foreground service; key/QR/deep-link onboarding, canonical config/state, supported service actions, no reverse-service UI or reverse UDP |
| macOS | One peer runtime in the native desktop app; TCP/HTTP and bounded UDP services; Unix byte-stream endpoints |
| Windows | One peer runtime in the native desktop app; TCP/HTTP and bounded UDP services; Unix sockets fail clearly |
| Headless CLI | Node.js 24 `peer` setup/key/status/pair/convert/run commands, gateway, TCP/HTTP/UDP service paths |
| Nix / Home Manager | Declarative `services.kepos.peer` config and a supervised `kepos peer run` unit |
| Container | Non-root image; deployment owns the canonical state directory, network, and supervision |

The repository's Kubernetes path is an operator-owned gateway pattern, not a
shipped cluster product. See [deployment](docs/deployment.md).

## Develop

Requirements: Node.js 24, npm 11, and initialized Git submodules for desktop
development.

```sh
git clone --recurse-submodules https://github.com/LamplitIsles/kepos.git
cd kepos
npm ci
npm run kepos -- --help
```

Run the full portable check:

```sh
npm run check
```

Useful platform checks are separate from the root check:

```sh
npm run android:check
npm run android:install
npm run android:device-check
npm run desktop:check
npm run desktop:native-check
```

`android:install` uses `adb install -r`, preserving app-private state. The
device lifecycle check installs the isolated `io.github.ttalab.kepos.devicetest`
package and uses test ports, so it does not replace or clear the installed
dogfood app. Run it only with a test device selected by `ANDROID_SERIAL` when
more than one device is connected.

Cloudflare Git Builds are disabled. Website deployment is a local post-merge
operation; do not use the deploy command for ordinary development.

## More repository documentation

- [Android](docs/platforms/android.md)
- [macOS desktop](docs/platforms/macos.md)
- [Windows desktop](docs/platforms/windows.md)
- [Maintainer release procedure](docs/releasing.md)
- [Architecture decisions](docs/adr/)
- [Physical and field evidence](docs/evidence/)

Evidence remains historical or environmental context. It is not a claim that
this implementation run performed deployment, a live GUI test, or real
identity conversion.

## License

[Apache License 2.0](LICENSE)
