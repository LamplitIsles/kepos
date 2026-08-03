# Kepos Neo

[![CI](https://github.com/tta-lab/kepos-neo/actions/workflows/check.yml/badge.svg?branch=main&event=push)](https://github.com/tta-lab/kepos-neo/actions/workflows/check.yml)
[![codecov](https://codecov.io/github/tta-lab/kepos-neo/graph/badge.svg?branch=main)](https://app.codecov.io/github/tta-lab/kepos-neo)

**Share a service, not a network.**

Kepos gives trusted devices access to the services you choose without exposing
those services on a public TCP port. A publisher might share Navidrome and SSH;
an approved phone or laptop receives ordinary local URLs and ports for only
those services.

There is no Kepos account and no Kepos-operated control plane. Device keys stay
on the devices that created them. The publisher decides who may connect and can
apply a narrower allowlist to each service.

> Kepos Neo is a developer preview. Android APKs and Apple Silicon macOS ZIPs
> are published for direct download with minisign verification. They are not
> app-store releases; the macOS app is ad-hoc signed and not notarized.

## Why Kepos exists

You have music, files, development tools, or an SSH shell running somewhere
else. Making them reachable usually means publishing ports, joining every
device to a virtual network, or trusting a hosted account to define the
relationship.

Kepos takes a smaller view:

1. The computer running a service publishes its name, not its whole network.
2. You choose **Add device** and show a short-lived QR code.
3. The new device proves which cryptographic key it owns.
4. You inspect its fingerprint and choose **Allow** or **Deny**.
5. An allowed service appears as a local address such as
   `http://navidrome.localhost:17480/` or `ssh -p 2222 user@127.0.0.1`.

Approval promotes the connection that carried the pairing request. The new
device does not need a publisher restart or a second NAT traversal. Unknown
devices cannot read the service registry while they wait.

The implementation follows four rules:

- **Services are the unit of sharing.** Access to one machine does not imply
  access to every port on it.
- **Devices own their identity.** Public keys are shared; secret keys are not
  copied between installations.
- **The local side stays boring.** Existing browsers, SSH clients, and CLIs use
  loopback URLs and ports.
- **Failure is visible and bounded.** Local listeners survive reconnects, stale
  peer paths are replaced, and hole-punch observations omit candidate IP
  addresses.

## What works today

| Surface | Roles | Current boundary |
| --- | --- | --- |
| Headless CLI | Publisher and subscriber | Node.js 24; persistent local HTTP gateway and raw TCP listeners |
| Nix / Home Manager | Publisher and CLI | Declarative public policy; private keys never enter the Nix store |
| Container | Publisher and subscriber | Non-root `linux/amd64` image published to GHCR from `main` |
| Kubernetes path | Subscriber gateway | Pod-facing hostname routing exists; reusable manifests are not yet shipped here |
| Android | Subscriber | Android 12+, `arm64-v8a`, sideload-only; one persistent Bare Worklet |
| macOS | Publisher, subscriber, or both | Apple Silicon, ad-hoc-signed local build, native tray app |

The container and Pod-facing gateway have also been exercised in a private
Kubernetes deployment. That proves the path, not a supported cluster product:
operators still own DNS, same-node routing, firewall rules, and rollout.

On Android, HTTP services use `http://<service-id>.localhost:17480/`. Registry
entries without a built-in action use that HTTP fallback instead of being
hidden. The one fixed raw listener, `127.0.0.1:17890`, maps to Mihomo's mixed
port for HTTP proxy and SOCKS5 TCP clients; Kepos does not carry Mihomo's UDP
listener.

## The path through Kepos

```text
browser / ssh / native app
          |
          | localhost URL or TCP port
          v
  subscriber gateway
          |
          | named Protomux channel
          v
 one authenticated HyperDHT connection
          |
          | named Protomux channel
          v
      publisher
          |
          | loopback TCP
          v
   Navidrome / SSH / Dagger / another TCP service
```

A bootstrap node helps a peer enter the DHT. It does not grant access and is
not the service endpoint. Peer keys authenticate the encrypted outer
connection; publisher and per-service allowlists authorize what can be opened.

## For Holepunch developers

Kepos is built on the Holepunch stack rather than hiding it behind a generic
VPN interface.

- **HyperDHT + UDX** provide authenticated peer connections, NAT traversal,
  path migration, reliable ordered streams, and transport counters over UDP.
- **Protomux** carries the registry, heartbeat control, pairing, and independent
  service channels on one persistent outer connection.
- The tunnel is a **split TCP byte-stream proxy over UDX**. Local TCP ends at
  each Kepos peer; `OPEN`, data, half-close, reset, and backpressure cross the
  multiplexed channel instead of TCP packets.
- **Bare** runs the shared subscriber core inside a persistent Android Worklet
  and powers the native macOS host. The desktop app starts no Node or Electron
  child process.
- A control heartbeat replaces silent paths in bounded time. A publisher keeps
  only one current control-ready outer connection for each authenticated
  subscriber identity, so a recovered path cannot race an older one for new
  service opens.
- HTTP services share one hostname gateway. Raw protocols such as SSH keep
  explicit local listeners. Both reuse the same authenticated outer
  connection.

The native work has required changes in the pinned `bare-app-kit`,
`bare-web-kit`, and `bare-native` forks for WebView messaging, deterministic
teardown, external URL handling, window lifecycle, and macOS tray support.
Those forks are Git submodules so their exact revisions remain reviewable.

The deeper transport model, including where Noise, UDX, Protomux, and local TCP
begin and end, is documented in
[Network transport and compatibility](docs/network-transport-and-compatibility.md).

## Trust and keys

Every publisher and subscriber has a cryptographic key pair. The long
hexadecimal value shown by Kepos is a public key, not a bearer token.

- Share a subscriber public key so a publisher can allow it.
- Pin the publisher public key so the subscriber connects to the intended peer.
- Keep publisher seeds and subscriber secret keys on the device that created
  them. Copying one identity makes two installations impersonate the same
  device.
- An empty publisher allowlist denies every subscriber. A service may inherit
  that list, narrow it, or explicitly deny everyone.

CLI identities live in the selected state directory. Android identities live
in app-private storage. Public keys and fingerprints may be displayed and
copied freely; private state must not be committed or placed in logs.

## Start developing

Requirements:

- Node.js 24
- npm 11
- Git submodules for desktop development

```sh
git clone --recurse-submodules https://github.com/tta-lab/kepos-neo.git
cd kepos-neo
npm ci
npm run kepos -- --help
```

Run the full portable check:

```sh
npm run check
```

Platform checks and builds are separate:

```sh
npm run android:check
npm run android:install
npm run android:device-check
npm run desktop:check
npm run desktop:native-check
```

`android:install` uses `adb install -r`, preserving app-private state and the
subscriber identity. Physical-device tests use the isolated
`io.github.ttalab.kepos.devicetest` package, so the test runner cannot replace
or remove the installed Kepos app.

## Documentation

- [CLI, identity, and configuration](docs/cli.md)
- [Android subscriber](docs/platforms/android.md)
- [macOS desktop](docs/platforms/macos.md)
- [Release and artifact verification](docs/releasing.md)
- [Nix, container, and Kubernetes deployment](docs/deployment.md)
- [Network transport and compatibility](docs/network-transport-and-compatibility.md)
- [How Kepos grew from Hypertele](docs/hypertele-provenance.md)
- [Proposed Capacitor Bare Kit Android bounty](docs/capacitor-bare-kit-android-bounty.md)
- [Architecture decisions](docs/adr/)
- [Physical and field evidence](docs/evidence/)

The evidence directory records exact environments, commands, failures, and
remaining gates. It is kept separate from product claims so a successful spike
does not silently become a support promise.

## License

[Apache License 2.0](LICENSE)
