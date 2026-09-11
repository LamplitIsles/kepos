# Kepos architecture

This document describes the implemented peer-services model for contributors
and operators. The [Kepos user documentation](https://kepos.guion.io/docs/)
remains the installation and end-user guide.

## System boundary

Kepos is a service-scoped proxy for split TCP byte streams and bounded UDP
datagrams. It is not an IP router, VPN, TUN device, or blind target forwarder.

```text
local client
  | loopback HTTP, TCP, or UDP endpoint
  v
peer gateway or binding
  | named service open / bounded datagram envelope
  v
Protomux + Noise SecretStream
  | one authenticated outer connection
  v
HyperDHT / UDX over UDP
  v
authenticated peer
  | fixed local source or explicit upstream peer/service source
  v
service endpoint
```

TCP terminates locally at both ends. `OPEN`, data, half-close, reset,
backpressure, and authorization status use a Protomux channel; TCP headers and
TCP acknowledgements do not cross the outer connection. A raw `tcp` service is
byte-transparent. An `http` service opts into the existing HTTP/1.1 framing
adapter and immediate-peer identity header. A `udp` service retains datagram
boundaries over encrypted unordered messages and maps only to a fixed IPv4
loopback target.

The Internet carrier is a separate layer. HyperDHT handles discovery,
authentication setup, and NAT punching. UDX provides the reliable ordered
outer stream over UDP. Noise SecretStream encrypts and authenticates the
stream and supplies the unordered message surface used by UDP. A bootstrap
node helps a peer enter the DHT; it does not authorize a peer or become a
service endpoint.

## One identity, independent connection direction

The canonical runtime loads one seed-only `peer.json`, derives one HyperDHT
keypair, and uses that key for both dialing and accepting. `peers` entries
select a local `dial` or `accept` direction for each remote public key. The
same runtime can accept one peer and dial another with the same identity.

```text
peer identity
  +-- peer A: accept
  +-- peer B: dial
  +-- local service sources
  +-- upstream service opens
  +-- local bindings
```

The direction of a connection does not decide which end provides a service.
Once a connection is authenticated, the two new peers negotiate
`kepos/peer-services/1` with the `byte-stream-v1` handshake. A `ready` result
enables named byte-stream opens in either direction. A timeout or an unknown
handshake is `unsupported`; the runtime never sends a reverse request to a
legacy endpoint and never creates a second connection to satisfy one.

Legacy server-side service protocols remain installed at the wire boundary.
An old subscriber can still pair with an upgraded accept side, read Home, and
use established TCP, HTTP, and UDP operations. It does not receive the new
reverse capability. New-client → old-server compatibility is intentionally not
implemented.

## Configuration and ownership

`src/config.ts` is the strict in-memory schema and `src/app-config.ts` is the
snake_case TOML boundary. The root has only optional `network`/`gateway`/
`metrics` and required `peers`, `services`, and `bindings` arrays.

```text
peers       authenticated remote identity + local dial/accept direction
services    published source + kind + immediate-peer allowlist
bindings    locally owned endpoint for one remote peer/service
network     DHT bootstrap and route preference
gateway     local HTTP host/port/domain
metrics     optional Prometheus host/port listener
```

A service source is exactly one fixed loopback port, fixed Unix socket, or
peer/service reference. A binding endpoint is local and cannot be selected by
remote input. Unknown fields, old role tables, obsolete flags, incomplete
references, invalid paths/ports, duplicate labels/keys/IDs, and duplicate
bindings fail parsing. Empty or missing service `allow` is deny-by-default.

The runtime owns the active config, peer entries keyed by authenticated public
key, current connection generation, service catalogs, local binding listeners,
and local Home registry servers. Home is a catalog, not an authorization
source: it is served only over an authenticated channel, and every open is
checked again against the current local grant.

## Service channels and republication

For a local source, `acceptService` connects to the configured loopback port or
Unix socket. For an upstream source, it opens the selected service on the
current connection to that exact peer. The republisher does not dial an
upstream because it is a provider; it uses whichever configured relationship
is current. Its downstream service has its own ID, name, and `allow` list.

```text
Mac peer --(Mac dials NUC; NUC accepts)--> NUC peer
  Mac service: cua  -- authorized upstream open --> NUC service: mac-cua
                                                    -- authorized downstream open --> phone
```

Each hop authorizes its immediate authenticated public key. The republisher
terminates and recreates each TCP/HTTP stream or UDP flow and therefore sees
plaintext at its hop. No end-user identity is delegated upstream, no catalog
is implicitly imported, and a binding alone does not put a service in the
local catalog. Operators keep source relationships acyclic; the runtime does
not discover or silently reroute cycles.

Connection replacement increments a peer generation. Only the current
generation can serve new opens or clear the peer's current status. A close
from an older stream cannot invalidate a replacement. Policy changes close
active service channels and UDP flows before new opens are admitted; a
reconnect never replays bytes or application actions.

## Local endpoint behavior

TCP and Unix byte streams share the same `Duplex` bridge and half-close
semantics. A UDP binding owns a local loopback datagram listener and maps each
local flow to the existing bounded forward UDP envelopes on the authenticated
connection. It is usable only when its configured peer is a `dial` peer;
accept-side UDP bindings remain unavailable and do not create reverse UDP.
Local bindings are created even when their peer is offline and are reported
unavailable until the remote catalog and grant are current. A client
connection is paused while it waits for acquisition and is destroyed on
timeout, cancellation, revocation, or source failure.

Unix paths are absolute and bounded by the platform socket limit. Unix sources
and bindings fail clearly on Windows. A binding refuses an occupied path; it
does not unlink a pre-existing socket. On shutdown or reconfiguration, Kepos
unlinks only a socket whose device/inode still matches the socket it created.
TCP port `0` is supported for bindings and the selected port is exposed in
status. Service source ports are fixed positive ports.

The HTTP gateway keeps unqualified names such as
`http://dsh.localhost:17480/`. If several current catalogs expose the same
TCP/HTTP service ID, lookup reports `Service is ambiguous` unless one explicit
binding selects a peer. Timing, insertion order, and reconnect order never
select a destination. Raw streams receive no HTTP headers. The HTTP adapter
removes caller `Authorization` fields and inserts exactly the authenticated
immediate peer key for each request; it supports HTTP/1.1 and valid `ws://`
upgrades only.

UDP remains a fixed-target application mapping, not reverse byte-stream
support. The existing forward operation carries bounded envelopes over the
same authenticated connection, supports local and explicit upstream UDP
sources, and enforces flow, rate, fragment, idle, and ACL limits. Application
datagrams are capped at 1,200 bytes and carrier fragments at 1,000 bytes.
Reverse UDP requested through a byte-stream binding returns an explicit
unsupported error. UDP bindings are a forward consumer operation only; they do
not make a service a reverse-open capability.

The canonical `src/services/presentation.ts` module owns service actions,
icons, access labels, URLs, and copy text. Desktop and Android consume that
metadata from runtime status rather than inferring behavior from service IDs.
The peer runtime also owns the purpose-named metrics collector and optional
read-only `/metrics` listener. It emits the existing
`kepos_publisher_*` series, with authenticated immediate-peer labels and
current-connection gauges, so the shipped Grafana artifact and existing
scrapers keep their contract without a second publisher runtime.

## Host boundaries

### CLI

`peer run` owns the canonical DHT node, gateway, bindings, reload loop, and
peer runtime lock. `setup peer`, `peer key`, `peer status`, `peer pair`/`trust`,
and `peer convert` operate on the canonical identity/config contract. The
runtime uses the existing observation, heartbeat, mux, and cleanup seams.

### Desktop

The native desktop host owns one canonical peer runtime, WebView, tray/menu
surface, paths, diagnostics, singleton lock, and shutdown. The peer surface
shows the public identity, relationship direction/capability, services,
bindings, gateway, and pairing state. It does not expose private seeds. The
desktop pairing invitation admits one unknown candidate temporarily; approval
persists the public key as an `accept` peer but does not add service grants.

### Android and Bare

The Android foreground service owns one persistent Bare Worklet. The Worklet
loads the canonical peer identity/configuration and starts the same `startPeer`
runtime used by the repository-owned hosts. Shared bootstrap/config generation
reads the canonical `[network]` settings. A fresh install can enter a peer
public key or consume a `kepos://pair?...` invitation from the QR scanner or a
deep link; the Worklet persists the resulting canonical peer policy and
reconnects it through the host IPC. Admission and service grants remain
separate. The UI is a status/service console with the canonical action metadata
for supported services; it does not grow a general configuration editor,
reverse-service UI, or reverse UDP interface. Previously built Android binaries
are the frozen legacy-client interoperability targets; they are not a second
fresh-build runtime or configuration source. The Bare host protocol remains
the lifecycle boundary between Kotlin and the Worklet.

### Nix/Home Manager

`services.kepos.peer` generates the canonical TOML, keeps `peer.json` in a
mutable state directory outside the Nix store, runs `setup peer` as
`ExecStartPre`, and supervises `peer run` as a user service. Generated public
keys, directions, sources, grants, bindings, gateway, and metrics settings are
parsed by the same runtime schema. Private seeds never enter the store.

## State and lifecycle

Canonical state is exactly a `0700` directory containing owner-only `peer.json`
with a seed. It has one stable sibling kernel lock. A second process cannot
use the same identity; lock-file existence is not treated as ownership and
must not be manually deleted while a process may be active. Runtime stop
closes candidates, current mux channels, bindings, gateway, Home servers, and
owned DHT resources in dependency order.

The offline conversion helper is separate from startup. It accepts an
explicit old publisher seed or validated subscriber keypair, requires and
verifies the expected retained public key, refuses overwrite/linked/ambiguous
sources, and writes a new private canonical directory. It does not inspect
live state, print private material, or create a legacy fallback.

## Diagnostics and safety

Observations are sanitized diagnostics. They may identify a bounded peer key
fingerprint and transport counters, but not seeds, secret keys, pairing
tokens, or candidate addresses. The stable operational distinctions are:

```text
offline       configured peer/source has no usable current connection
unsupported   connected peer lacks the reverse capability
unauthorized  authenticated peer lacks the service grant/catalog entry
conflicting   multiple visible same-name services require an explicit binding
```

The transport has no generic TCP relay fallback, arbitrary target forwarding,
automatic direction election, retired-key alias, or old schema migration.
Those boundaries are deliberate and are described in
[network transport and compatibility](network-transport-and-compatibility.md).

## Related decisions

- [ADR 0013: Peer identity and independent connection/service roles](adr/0013-separate-connection-roles-from-service-roles.md) — accepted implementation decision.
- [ADR 0012: Explicit service republication](adr/0012-explicit-service-republication.md) — historical publisher wording retained where it describes the existing wire contract; canonical peer identity supersedes its role exception.
- [ADR 0010: Publisher identity state and TOML policy](adr/0010-publisher-identity-state-and-toml-policy.md) — historical state decision; canonical `peer.json` and peer TOML supersede its runtime ownership.
- [ADR 0008: Share one HyperDHT node per device runtime](adr/0008-share-one-hyperdht-node-per-device-runtime.md) — transport lifecycle contract retained by host integrations.
- [ADR 0003: Android subscriber and Bare host boundaries](adr/0003-android-subscriber-and-bare-host-boundaries.md) — legacy client/host boundary retained.
