# Kepos network transport and compatibility

Status: current implementation boundary
Date: 2026-09-11

Kepos connects one authenticated peer identity to another and exposes named
services at the application boundary. It does not create an IP subnet, carry
TCP/UDP packets end to end, or accept arbitrary remote targets.

## Current transport stack

The direct path is:

```text
local client
  | loopback HTTP/TCP/UDP
  v
Kepos binding or gateway
  | Protomux stream / encrypted UDP envelope
  v
Noise SecretStream outer connection
  | reliable ordered UDX stream
  v
HyperDHT discovery and NAT punching over UDP
  | one authenticated peer connection
  v
remote Kepos runtime
  | fixed local source or explicit upstream peer/service source
  v
service endpoint
```

The layers have different contracts:

| Layer | Kepos responsibility | Mechanism |
| --- | --- | --- |
| Local service | Fixed TCP/HTTP/Unix byte stream or fixed-target IPv4 UDP | Node/Bare local sockets |
| Service tunnel | Open, data, half-close, reset, status, flow control | Protomux + `Duplex` |
| UDP service operation | Datagram boundaries, bounded flow IDs/fragments | SecretStream unordered messages |
| Peer security | Authenticate configured public key and encrypt bytes | Noise SecretStream |
| Internet carrier | Discovery, announcement, punching, reliable outer bytes | HyperDHT + UDX over UDP |

UDX's reliability applies to the ordered outer byte stream, not to the
application's UDP service. UDP service datagrams are bounded and unordered;
Kepos does not add retransmission or reliable delivery to them.

## One outer connection, either service direction

Each runtime loads one seed-only `peer.json` and derives one HyperDHT keypair.
The canonical `peers` array decides whether this runtime dials or accepts a
relationship. Service direction is independent of that connection direction.

After authentication, both new peers open the
`kepos/peer-services/1` capability protocol and exchange `byte-stream-v1`.
Only a `ready` result permits reverse named byte-stream opens. A timeout or
unknown handshake becomes `unsupported`; the runtime does not probe an old
wire format, open a second reverse connection, or silently reroute to another
peer.

```text
Mac (dial)  ---------------------->  NUC (accept)
             one authenticated outer
Mac service  <==== authorized stream ====
NUC service  ==== authorized stream ====>
```

The current-generation connection is selected by authenticated remote public
key. A replacement connection supersedes its predecessor. A close from the
old generation cannot clear the new connection or keep old service channels
usable. Policy revocation, source changes, and disconnects close affected
channels/flows; bytes and application operations are never replayed after
reconnect.

## Service sources and republication

Canonical service sources are exactly one of:

- fixed loopback `local_port`;
- fixed absolute `unix_socket` for a byte stream;
- an explicit `peer` plus upstream `service` ID.

Bindings own a local loopback TCP/UDP port or Unix socket for one remote peer
and service. Set the binding kind to `udp` for a forward datagram listener;
UDP bindings require a loopback port and use the authenticated connection's
existing bounded UDP envelopes. A UDP binding is usable only for a configured
`dial` peer; a binding targeting an `accept` peer remains unavailable because
local UDP consumption is forward-only. A byte-stream binding is the default
and Unix endpoints remain byte-stream only. The endpoint is selected locally;
remote messages cannot choose it. An imported service is not published merely
because it has a binding.

Republication is a new local service entry:

```text
peer A service cua
        ^
        | NUC consumes exact peer/service source
        v
peer B service mac-cua -- own name + own allowlist --> peer C
```

The upstream peer authorizes the republisher's key. The republisher's service
allowlist independently authorizes the downstream peer. Every hop terminates
and recreates the stream or UDP flow and may see plaintext; the downstream
identity is not delegated upstream. There is no catalog import, implicit
fallback, cycle discovery, or unrelated-peer rerouting. Operators keep source
relationships acyclic.

## TCP and HTTP

Raw `tcp` is payload-transparent. A local TCP connection terminates at the
consumer and a separate local connection starts at the immediate provider or
republisher. Protomux carries lifecycle and payload messages while the stream
backpressure and half-close behavior remain visible to both local sockets.

`http` is an opt-in plaintext HTTP/1.1 adapter. It removes all caller-supplied
`Authorization` fields and sends exactly one header to the immediate target:

```http
Authorization: Kepos <authenticated-immediate-peer-public-key>
```

This is a device assertion, not a bearer secret. Keep the target private to
the Kepos ingress because a direct target connection could forge it. Ordinary
HTTP/1.1 requests, bodies, sequential keep-alive, and valid `ws://` upgrades
are supported. HTTPS/TLS, `wss://`, HTTP/2/h2c, HTTP/3, CONNECT, and other
upgrades are outside the adapter contract. Raw TCP receives no added header.

## UDP service operation

The established forward UDP path is deliberately narrower than the carrier:

```text
local UDP listener
  | service ID + flow ID + bounded datagram
  v
encrypted unordered message on the peer outer
  v
fixed connected IPv4 loopback target
```

An application datagram may be at most 1,200 bytes. Carrier fragments are at
most 1,000 payload bytes; a 1,001–1,200-byte datagram uses bounded fragments
and is reassembled without retransmission. Flows have idle, count, pending
send, byte, and datagram budgets. ACL checks happen before target socket
creation. Broadcast, multicast, arbitrary destinations, IPv6 local listeners,
and reliable delivery are not provided.

Explicit upstream UDP sources are supported for existing forward
republication: the republisher maps each downstream flow to a fresh upstream
flow on the current authenticated connection and returns replies only to that
downstream flow. Source outage, policy revocation, connection replacement,
rate limits, and flow expiry remove the mapping. Opening a UDP service through
the new reverse byte-stream operation returns a truthful unsupported error;
this change does not add reverse UDP.

## Discovery, authentication, and authorization

HyperDHT bootstrap and lookup are discovery and NAT traversal only. A
bootstrap node cannot add a key to `peers` or a service `allow` list, and it
does not become the application endpoint. Noise authenticates the remote
public key before the runtime creates an authorized service surface.

The runtime then checks the current configured relationship and the service's
immediate-peer allowlist. Home is an authenticated catalog, not a grant. A
service absent from the catalog or marked unavailable is not a reason to
choose another peer. The operational distinctions are:

```text
offline       no current usable connection/source
unsupported   connected endpoint lacks peer-services capability
unauthorized  authenticated peer lacks the service grant
conflicting   multiple visible same-name services require an explicit binding
```

Pairing is an admission workflow, not a service grant. Approval persists the
candidate's public key as a configured peer and authorizes its current
connection; it does not modify any service `allow` list.

## Gateway names and conflicts

The HTTP gateway retains unqualified names:

```text
http://<service-id>.localhost:17480/
```

`home.localhost` exposes the authenticated machine-readable registry. An
optional configured domain adds another suffix but does not replace
`.localhost` or install DNS. When multiple current catalogs offer the same
TCP/HTTP service ID, the gateway reports an ambiguity until one explicit
binding selects a peer. It never chooses by timing, insertion order, or
reconnect order. The registry keeps its legacy `tcp`/`udp` kind values and may
add `access = "http"` metadata so newer clients retain the canonical HTTP
action without changing the established wire kind. UDP services are endpoints
to copy/use, not browser actions.

The canonical peer runtime can expose the existing Prometheus contract through
an optional read-only `/metrics` listener configured by `[metrics]` or the
`peer run --metrics-listen host:port` override. The purpose-named peer collector
keeps the established `kepos_publisher_*` names, immediate-peer labels,
authorization gauges, active-channel gauges, and traffic counters; the
publisher runtime and shipped dashboard are not reintroduced or redesigned.

## Legacy-client compatibility

The upgraded accept side retains the existing pairing, Home registry, TCP,
HTTP, and UDP wire adapters. A frozen old subscriber/client can therefore
connect to a new server, receive only its authorized catalog, and use the
established service operations. It does not declare `kepos/peer-services/1`,
so reverse byte-stream requests are unavailable and do not trigger a second
dial.

This is a one-way compatibility promise: old client → new server for the
established operations. New client → old server is not promised and has no
legacy probing or compatibility fallback. Configuration compatibility is
separate: old publisher/subscriber TOML tables, flags, contacts, and startup
state paths are rejected/not read even though the old network wire remains at
the boundary.

## Network limits and deferred relays

The current direct path requires usable outbound UDP and a NAT pair HyperDHT
can punch. The DHT candidate listener range (normally `49737–49741`) is not a
promise that ephemeral UDX connection sockets will be reachable. VPN/TUN
interfaces, WSL NAT, enterprise filtering, mobile CGNAT, and UDP shaping can
change the result. Route `auto` permits the existing LAN shortcut; `public`
disables only that shortcut for comparison.

There is no production TCP/443 relay, WebSocket relay, generic UDP relay,
automatic path election, or public service port in this implementation. A
future blind UDX relay could carry Noise ciphertext when direct punching
fails; a future TCP/TLS or WSS gateway could cover networks that block all
UDP. Those designs require independent security, capacity, abuse, metadata,
and reconnect validation and are deferred rather than silently implied by
the current API.

## Observability and test boundary

Structured `peer run --observations ndjson` output correlates an outer
connection with its service channels and includes bounded transport/status
information. Diagnostics must not contain seeds, secret keys, pairing tokens,
full candidate addresses, or state files. They are not a stable API.

The repository proves the direct transport with test-owned HyperDHT testnets,
temporary TCP/Unix/UDP listeners, old-client wire paths, and controllable
fakes. Those checks do not prove every NAT class, a production relay, or a
live Mac GUI/cua-driver installation. A later operator smoke procedure is
documented in [DeepSeek Harness integration](integrations/deepseek-harness.md).
