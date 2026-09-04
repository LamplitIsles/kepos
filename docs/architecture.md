# Kepos architecture

This document is for contributors and operators who need the implementation
model. The [Kepos user documentation](https://kepos.guion.io/docs/) is the
primary guide for installing and using the product.

## System boundary

Kepos is a service-scoped, split TCP byte-stream proxy. It does not create an
IP subnet and it does not forward TCP packets end to end.

```text
browser / SSH / native client
          |
          | local URL or TCP port
          v
 subscriber gateway or listener
          |
          | OPEN / DATA / FIN / RESET
          v
      Protomux channel
          |
          v
 Noise-encrypted outer stream
          |
          v
       UDX over UDP
          |
          v
        publisher
          |
          | loopback TCP
          v
    Navidrome / SSH / another service
```

The local TCP connection terminates at the subscriber and a separate local TCP
connection starts at the publisher. Kepos moves payload bytes, lifecycle
messages, and backpressure through a Protomux channel. TCP headers and TCP
acknowledgements do not cross the peer connection.

The transport carries TCP byte streams for every service. The default `tcp`
kind is byte-transparent. A publisher may instead opt a plaintext HTTP/1.1
target into `http`: a framing-aware publisher-side adapter replaces every
target-facing `Authorization` field with the authenticated subscriber device
key, and supports a `ws://` Upgrade after a valid target `101` response. It does
not add TLS, HTTP/2, h2c, HTTP/3, CONNECT, or a generic Upgrade tunnel. The
[CLI HTTP service contract](cli.md#http-service-device-authentication) defines
the target-facing header and its private-ingress security boundary.

The Internet carrier is a different layer: HyperDHT discovers peers and
coordinates NAT traversal, UDX provides reliable ordered streams over UDP, and
Noise protects the peer connection. A bootstrap node helps a peer enter the
DHT; it does not authorize a subscriber or act as the service endpoint.

## Roles and authority

A **publisher** listens under a publisher-owned key, advertises a registry of
named services, and checks the subscriber public key against its local
subscriber-device policy. Each trusted device has a publisher-local label and
public key. A service may inherit that policy or narrow it with its own
public-key allowlist. An empty subscriber-device list denies every subscriber.

A **subscriber** owns a separate client identity and pins one publisher
contact. Once its outer connection is authorized, it reads the registry and
opens only the named services that the publisher returned. HTTP services share
the local hostname gateway; raw services receive explicit loopback listeners.

The registry is not an authorization database. It is returned only after the
publisher has authenticated and authorized the subscriber. Bootstrap, DHT, and
transport components cannot add a device to a publisher subscriber-device
policy.

## Holepunch stack

Kepos uses the Holepunch networking primitives directly rather than presenting
a generic VPN abstraction:

- **HyperDHT** handles peer discovery, announcement, connection setup, and NAT
  punching.
- **UDX** carries the encrypted reliable stream over UDP. It supplies ordering,
  retransmission, congestion control, and flow control for the outer stream.
- **Noise SecretStream** authenticates the peer keys and encrypts the outer
  byte stream.
- **Protomux** multiplexes the registry, heartbeat, pairing, and independent
  service channels on the authenticated connection.
- **Bare** hosts the shared JavaScript runtime inside the Android Worklet and
  the native desktop application. The desktop package has no Node or Electron
  child process.

A dual-role device owns one HyperDHT node and lends it to the publisher and
subscriber roles. That shared transport does not merge their identities,
allowlists, state directories, locks, or wire protocols. Standalone CLI role
commands can still own independent nodes when separate transport policy or
failure isolation is required.

The detailed layer model, NAT behavior, relay terminology, and compatibility
limits live in [Network transport and compatibility](network-transport-and-compatibility.md).

## Host and runtime boundaries

### Android

The Kotlin Android app owns the Activity, Compose UI, foreground service,
notifications, and user start/stop actions. The foreground service owns one
persistent Bare Worklet. The Worklet runs the shared subscriber runtime and
binds the app's local gateway and fixed raw listeners. Closing the Activity does
not stop that Worklet; an explicit service stop does.

The Android app is subscriber-only. Its identity is created in app-private
storage and preserved across an in-place update. It never copies a publisher
seed or another device's secret key.

### Desktop

The native desktop host owns the window, WebView, menu-bar or notification-area
lifecycle, and one shared device runtime. The WebView renders the relationship
UI; native code owns process supervision, filesystem paths, diagnostics, and
external URL opening.

A desktop can run publisher-only, subscriber-only, or both. Each role has its
own state directory and runtime lock. A publisher's **Add device** invitation
is a two-minute QR flow for an Android subscriber. Android connects with its
existing identity; the publisher sees the candidate fingerprint and must
approve it before the connection is promoted to the normal registry and service
protocols. A desktop subscriber currently uses the manual path: copy its public
key and a local label into the desktop publisher's TOML subscriber-device policy;
the running publisher reconciles that policy without a restart,
copy the publisher public key, and enter it in **Connect this subscriber**. The
desktop app does not receive the QR invitation through a deep link.

The packaged first run creates a default config and enabled role identities when
they are absent. When publisher startup is enabled, it creates missing publisher
state from the TOML display name, subscriber-device, and service policy. If publisher
state already exists, startup validates the state files themselves and reuses
their seed and public key; mutable TOML policy may change without rewriting
that identity. CLI `setup publisher` retains its strict idempotency. A config
or identity is never silently replaced to make startup succeed.

The desktop process hides rather than quits when its main window closes. Tray
or menu-bar **Open Kepos** restores the window; **Quit Kepos** stops publisher,
subscriber, WebView, tray, and runtime resources through one idempotent
shutdown path.

### Windows packaging

The Windows release is a self-contained x64 App Runtime tree in a portable ZIP.
`App\\Kepos.exe` and the companion files must remain together. The optional
per-user `Install.cmd` copies the complete tree and owns its shortcuts; it is
not an MSI, MSIX, service, login task, or updater. WebView2 and the Microsoft
Visual C++ Redistributable remain host prerequisites.

## State, configuration, and lifecycle

The shared TOML file contains transport bootstrap settings and optional role
policy. It does not contain private identity material. On Unix-like desktop
hosts the default paths are:

```text
~/.config/kepos/config.toml
~/.local/state/kepos-neo/publisher
~/.local/state/kepos-neo/subscriber
```

On Windows they are under `%APPDATA%\\Kepos\\config.toml` and
`%LOCALAPPDATA%\\Kepos\\state\\{publisher,subscriber}`. Diagnostics live in
the corresponding state root.

Role state is created atomically and validated as a complete directory. A
publisher state contains its seed/config and service manifest. A subscriber
state contains its identity plus one active or pending publisher contact. A
pending contact is promoted after pairing approval; pairing tokens do not enter
durable state.

The desktop and CLI use matching per-role locks. A second process cannot use the
same role identity concurrently. Runtime startup is visible as role phases:

```text
starting -> running -> stopping -> stopped
                 \-> failed
```

The subscriber connection separately reports `connecting`, `connected`,
`reconnecting`, and `stopped`. Its local gateway and configured listeners can
remain bound during reconnect, although active client streams must be retried.
A heartbeat replaces a silent outer path in bounded time, and a newer
control-ready connection replaces an older connection for the same subscriber
identity.

A headless publisher reads its policy at startup and reconciles valid TOML
changes while it runs. Removing a subscriber device closes its active
connection; new devices and service authorizations appear immediately. Desktop
**Add device** is a special live Android pairing path: approval persists the
new labeled device, updates the in-memory policy, and promotes the final
connection without a second NAT traversal.

Publisher metrics are an optional `GET /metrics` endpoint. Its stable labels
are a subscriber-local label, a short public-key fingerprint, service, and
direction; full keys, addresses, and transport/channel IDs are excluded. The
Kepos-owned Grafana source and rendered Nix artifact are described in
[`docs/cli.md`](cli.md#publisher-metrics-and-dashboard).

## Diagnostics and safety

Desktop diagnostics are bounded, rotated, and sanitized. The summary can retain
role state, connection state, counters, and selected observations. It removes
secret keys, pairing tokens, seeds, and candidate IP addresses. The CLI's
structured observations follow the same boundary; their shape is diagnostic,
not a stable external API.

Transport failures must not be converted into availability promises. The
current product has no TCP relay fallback, no generic firewall bypass, no UDP
service protocol, and no virtual-network routing. A VPN or TUN interface can
still interfere with the UDP carrier, and operators must diagnose that boundary
rather than assume a fallback path.

## Related decisions

- [ADR 0003: Android subscriber and Bare host boundaries](adr/0003-android-subscriber-and-bare-host-boundaries.md)
- [ADR 0004: Two-level subscriber runtime locking](adr/0004-two-level-subscriber-runtime-locking.md)
- [ADR 0005: Centralize built-in service presentation](adr/0005-centralize-built-in-service-presentation.md)
- [ADR 0006: Desktop dual-role runtime ownership](adr/0006-desktop-dual-role-runtime-ownership.md)
- [ADR 0007: Pair on the final publisher connection](adr/0007-pair-on-the-final-publisher-connection.md)
- [ADR 0008: Share one HyperDHT node per device runtime](adr/0008-share-one-hyperdht-node-per-device-runtime.md)
