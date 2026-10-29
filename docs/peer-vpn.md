# Linux peer VPN foundation

The exclusive `peer vpn` runtime carries IPv4 TCP packets between explicitly
configured Kepos identities. It uses a Linux TUN interface, a /32 local
address, one /32 route per remote peer, and MTU 1400. It does not forward
subnets, act as an exit node, forward application UDP, or provide an IPv6
overlay. HyperDHT discovery and the UDX carrier still require UDP on the
physical network. A direct path is required; no relay is provisioned here.
macOS, iOS, Android, and Windows VPN implementations are not supplied.

Build the helper in the checkout with a Linux C compiler and kernel headers:

```sh
npm run vpn:build
```

The CLI needs Node and the normal project dependencies, `ip` from iproute2,
`/dev/net/tun`, and `CAP_NET_ADMIN` in its network namespace for TUN, address,
and route setup. Run under an appropriately privileged service account or
namespace; permissions failures and missing executables are reported. The
helper is a separate binary at `.build/kepos-tun`. Run `peer vpn` with an explicit helper path:

```sh
npm run kepos -- peer vpn --state /path/to/peer --config /path/to/config.toml \
  --tun-helper "$PWD/.build/kepos-tun"
```

Initialize each identity with `setup peer` and exchange public keys securely.
Give each peer a different stable IPv4 unicast address. For example, peer A:

```toml
[[peers]]
label = "b"
public_key = "<peer-b-public-key>"
connection = "dial"

[vpn]
address = "198.18.0.1"
peers = [{ peer = "b", address = "198.18.0.2", allow_tcp = [443] }]
```

Peer B uses its own key and address, lists A's key with `connection = "accept"`,
and maps A to `198.18.0.1`. `allow_tcp` is the local inbound policy for that
peer, so B needs `[443]` to let A open TCP port 443 on B; omit it or use `[]`
to deny new inbound connections, or use `"all"` to allow any TCP port. Peers
are identified by label or key and limited to 16 per VPN configuration. Both
sides must agree on their address mapping and use the VPN protocol; a service
runtime or other protocol is rejected. Device keys identify devices, not users.

The runtime binds packets from each Noise connection to that peer's configured
source address and the local destination address. Inbound new TCP flows need a
grant; valid replies to locally initiated flows are tracked independently of
inbound grants. The flow table is limited to 4096 entries per peer. Established
and half-closed connections retain their state while idle; incomplete handshakes
expire after five minutes. Once both FINs are acknowledged, closed flows retain
a 60-second grace for retransmissions. At capacity, the oldest closed flow may
be reclaimed early; if every entry is active, new flows are denied until space
is available. An established flow whose endpoints disappear without a FIN or
reset can occupy a slot until the peer disconnects or the VPN restarts. Reset,
disconnect, config reload, and shutdown discard relevant flow state.
Changes to a valid config are detected roughly once per second: the VPN is
stopped and restarted under the same lock, interrupting existing connections.
An invalid reload or failed restart stops the VPN instead of keeping old grants.

TCP and related IPv4 destination-unreachable, time-exceeded, and parameter-
problem errors are supported when the error quotes a tracked TCP flow and is
addressed to or from its configured peer. IPv4 fragments, IPv4 options, other
IP protocols, app UDP, and IPv6 packets are dropped. Packet and IP/TCP/ICMP
checksum/length failures are rejected. TCP Fast Open SYN payloads are not
supported. Applications and firewalls should allow normal TCP retransmission;
TUN output can be dropped when another peer is writing to the device.

The helper owns a nonpersistent TUN. Closing it removes the interface and its
routes, including on startup failure or process termination. Route creation uses
`ip route add`, so a conflicting existing route causes startup to fail instead
of replacing it. The VPN runtime uses an identity lock so only one runtime can own the identity.

Existing DNS must resolve a service name to the intended peer's VPN address;
Kepos does not alter DNS or Caddy, issue certificates, or configure application
access. Caddy must listen on that address and existing host firewalls must allow
the intended traffic. A VPN peer's source address identifies its configured
device, not an application user. Physical-network routes and UDP reachability
to HyperDHT must remain available independently of the narrow overlay routes.

The versioned packet stream is reliable and ordered, so loss can cause
head-of-line delay; no latency or battery improvement is claimed. The packet
parser holds at most one 1400-byte frame, the native helper holds one packet per
direction, and the application holds at most one TUN write at a time. These are
not bounds on all transport memory: the installed SecretStream accepts a
24-bit encrypted record length and can allocate up to 16,777,215 bytes for one
record before VPN parsing. For example, 16 simultaneous such allocations total
268,435,440 bytes, excluding transport queues and copies; this is not an
aggregate limit. The installed SecretStream exposes no documented option to cap
incoming record allocation before parsing. SecretStream requests raw-stream
pause on backpressure, but the installed
UDX JavaScript receive callback does not itself check the push result; native
receive/reordering bounds have not been verified. HyperDHT also creates a
handshake entry before its application firewall and retains rejected entries
for a default 10 seconds. There is no proven aggregate memory bound for
unauthenticated floods or native transport queues. Limit exposure at the host
and network boundary and review this residual risk before deployment.

The packet-policy and stream framing code are separate from the Linux helper so
future packet interfaces can reuse them. This does not establish an iOS Network
Extension integration: a minimal SDK provider typecheck and worklet/addon bundle
generation have been observed separately, but extension packaging, signing,
runtime loading, Apple policy compliance, IPv6-only underlay, and device behavior
remain unverified. One separately approved local Linux test with two peers and
a private four-node DHT exercised real TUN interfaces and host routes, allowed
and denied TCP, revocation and reconnection, peer removal, and shutdown cleanup.
Its authenticated spoof test observed a subsequent valid control SYN at the
receiver and no spoofed SYN in its TCP state; that observation does not exclude
every possible kernel-side rejection. This was one host and one test fixture,
not automated CI or evidence for other networks or operating systems.

VPN diagnostics distinguish DHT startup, authenticated admission, transport
connection, and the VPN protocol handshake. `VPN running` and `VPN DHT
listening` report local startup only; neither establishes that the remote peer
is reachable. Check both endpoints' logs and peer direction/key configuration
when a dial or handshake fails. A locally opened transport does not prove that
the remote accepted it. On handshake timeout the runtime logs a redacted
transport snapshot with available UDX packet counters. Repeated admission
messages are rate-limited. If an authenticated attempt does not reach the
server connection callback, another attempt can be admitted after one second;
an already active session still rejects duplicates.

In a small private DHT, NAT traversal can fail when too few distinct DHT
nodes respond to the socket's discovery probes. Check that the configured
bootstrap nodes are reachable over UDP and that they lead to enough reachable
DHT nodes. A short bootstrap list does not by itself establish a problem: one
bootstrap can discover other nodes, and an open or direct route may not need
the same NAT analysis. The runtime does not currently report the number of
successful NAT samples or identify this condition automatically.

For an isolated test network, the installed HyperDHT filters reserved IPv4
addresses from its LAN shortcut and treats RFC1918 addresses as private. For
example, the documentation prefix `192.0.2.0/24` is reserved, not a private
LAN underlay. A test using it may fail to find a local candidate even when its
interfaces are reachable. Use a test-owned private underlay when a separately
approved isolation plan calls for a LAN path; changing the underlay does not
prove that other discovery or transport paths work.
