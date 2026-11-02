# Peer VPN

## Managed receiver and invitations

A managed Linux receiver accepts up to 16 individually authorized dialers. Each device receives one persistent address and initially may open all TCP ports on the receiver; use `peer grant` to restrict it and `peer revoke` to remove it. The receiver never initiates TCP connections to devices. Traffic between dialers, application UDP, IPv6 and DNS changes are outside this feature. The host firewall and service authentication still apply.

Create a seed-only receiver identity with `setup peer`. Supply its existing intended service address in a configuration with no static peers:

```toml
peers = []
[vpn]
address = "192.168.1.88"
peers = []
```

Choose an unused pool that does not overlap the receiver's physical networks or other VPNs. The allocator excludes the receiver address. For illustration only, `198.18.20.0/24` is a benchmarking range, not an assumed production allocation. Start the service and create an invitation from a second shell as the same operating-system user:

```sh
npm run kepos -- peer receiver --state /path/to/peer --config /path/to/config.toml \
  --pool 198.18.20.0/24 --tun-helper "$PWD/.build/kepos-tun"
npm run kepos -- peer invite --state /path/to/peer
```

Paste the invitation into the Mac menu while disconnected. It contains the receiver's public key and a random bearer secret. The authenticated receiver checks the secret and binds the authenticated joining key to its grant and allocation; a contact from an unknown key alone cannot forward packets. The receiver stores only a hash of the invitation, expires it after ten minutes and consumes it in the same serialized durable state update as the grant. A failed validation or exhausted pool does not consume it. Existing devices keep their address and restricted grant when paired again. Invitation validation uses the receiver's system clock; correct time is necessary.

If the response is lost after the receiver commits, the Mac reports an unknown outcome. Inspect `peer devices` before taking further action; do not automatically replay an uncertain admission. The receiver's private `.<state-name>.receiver/receiver.json` holds allocations, policies and outstanding invitation hashes; its control socket is available only while the service runs. A storage error fails the receiver rather than continuing with a potentially stale policy. Changing an allocation or policy restarts the packet runtime and interrupts connections. The configured pool, receiver address and receiver public key are checked against stored state on restart.

If inspection shows that the affected device was admitted with an address that collides on the Mac, identify it by its public key and record its grant. Deliberately revoke only that device, then issue a new invitation that excludes its old address:

```sh
npm run kepos -- peer devices --state /path/to/peer
npm run kepos -- peer revoke --state /path/to/peer --key DEVICE_PUBLIC_KEY
npm run kepos -- peer invite --state /path/to/peer --exclude-address 198.18.20.2
```

Replace the example address with the affected device's actual allocation, and share the invitation privately. Issuance rejects an address still assigned to an authorized device. The exclusion applies only to this invitation, is not a global reservation, and does not change other devices' addresses or grants. If another invitation assigns that address before this invitation is used, re-pairing that existing identity is rejected without consuming the invitation; inspect and deliberately revoke it before re-admission. Any bearer can use an invitation, so deliver it to the intended device. A newly admitted device starts with all TCP ports allowed; restore any desired restricted grant explicitly. If the response is lost or the Mac finds another conflict after admission, inspect the receiver again before deciding what to do. Exclusion does not guarantee the new address is conflict-free on the Mac.

The Mac app extension owns the private `Kepos` directory in its app-group container, including the seed-only `peer` identity, runtime lock and `config.json`. The menu asks the provider for public state and does not read or transfer the seed or lock. The provider preserves an existing managed identity; a paired configuration with a missing identity fails rather than generating a replacement. If a previously selected identity is outside this location, setup stops with guidance; any migration or cutover requires a separately authorized operation. The invitation is passed to the provider only for temporary pairing; neither the template nor the receiver store contains its text. The provider saves the public pairing result before reporting success. Disconnect before pairing, and connect separately afterward.

Linux checks the pool against existing non-default routes on startup and before enrollment, and checks allocated peer addresses before adding routes. A pre-commit device-capacity, pool-exhaustion or receiver-route conflict reports a fixed reason to the device and a rate-limited diagnostic to the operator; storage failures and lost responses remain unknown outcomes. The Mac snapshots local IPv4 interface addresses with [getifaddrs](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man3/freeifaddrs.3.html) and the routing table with [NET_RT_DUMP](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man3/sysctl.3.html) before applying tunnel settings. It rejects an assigned address already on an interface, a receiver address belonging to the Mac, and an active explicit host route for the receiver. It permits a receiver in an attached LAN subnet and ignores link-layer/cloned host routes such as ARP entries. If a conflict is found after the receiver commits pairing, the Mac reports the conflict and asks the operator to inspect the possible admission before retrying.

These checks are snapshots: they cannot prove later route stability, route precedence, or which physical carrier path HyperDHT will use. An unsigned 0.1/28 App Extension bundle was built on N5 from `daaa0d35cd79c67f6def305ba8b731b8c82ed79f`. The user signed a development build, which was installed in an approved operation, and reported a connection and access. Orc separately observed the installed 0.1/28 `.appex`, connected status, a route to `192.168.1.88` through `utun8`, and trusted TLS and HTTP 200 access to FlickGrove over the VPN on the same LAN, with a transient N5 service. The installed signed executable was not independently byte-matched to that unsigned build. These observations do not establish invitation pairing, WAN/NAT paths, reboot behavior, negative security tests, or accessibility (AX) behavior. A previously approved isolated Mac/N5 test also succeeded with the same receiver and carrier address; neither test proves other routing paths. The prior system-extension implementation failed twice accessing the user's managed group container, and an isolated fixture reproduced the visible failure once; the precise errno was not observed. This app-extension design changes that context but has not reproduced the same red/green result. The earlier generic bridge failure has no established root cause and is not claimed fixed.

The packet tunnel is a user-context app extension: macOS terminates it when that user logs out, and the VPN does not run as a system-wide background service. Apple lists macOS packet-tunnel app extensions as App Store only for distribution; a development-signed build on a registered Mac is a development/test path, not a Developer ID website release. See [TN3134](https://developer.apple.com/documentation/technotes/tn3134-network-extension-provider-deployment). The current development host is not sandboxed so its existing external-identity selection remains visible; a future App Store build also requires host sandboxing and an explicitly authorized approach to any affected existing preferences. No live identity has been migrated by this change.

An earlier system extension may remain registered under the same provider identifier. How macOS chooses between that installed extension and the new app extension has not been verified. For a transition, inspect the installed state and arrange deactivation of the active old system extension under a separately authorized plan; macOS may require a restart. Recheck registration and provider selection afterward: old versions marked for removal at restart do not prove that identifier selection is resolved. The transition does not automatically deactivate the old extension, remove or replace an existing VPN manager, restart the Mac, or move an identity. Preparing managed state may create a Kepos VPN manager if none exists.

## Explicitly configured peers

The exclusive `peer vpn` runtime carries IPv4 TCP packets between explicitly
configured Kepos identities. It uses a Linux TUN interface, a /32 local
address, one /32 route per remote peer, and MTU 1400. It does not forward
subnets, act as an exit node, forward application UDP, or provide an IPv6
overlay. HyperDHT discovery and the UDX carrier still require UDP on the
physical network. A direct path is required; no relay is provisioned here.
An experimental macOS packet-tunnel implementation has undergone limited
Mac–Linux peer tests on a LAN. iOS, Android, and Windows VPN implementations
are not supplied.

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
disconnect, config reload, and shutdown discard relevant flow state. The Linux
CLI detects changes to a valid config roughly once per second: it stops and
restarts the VPN under the same lock, interrupting existing connections. An
invalid Linux reload or failed restart stops the VPN instead of keeping old
grants. The macOS app reads its selected config when connecting; disconnect and
reconnect to apply edits.

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

## Experimental macOS build

The current source packages a user-context packet-tunnel App Extension and a Bare
worklet. The menu distinguishes a running provider from a peer that has completed
the VPN greeting. The following historical tests used the earlier **system
extension**, not the current App Extension. On an Apple Silicon Mac, an Apple Development-signed build from commit
`bd8c7d3a9955bad9a5d28ddbf44861210eeed179` activated the system extension,
started a zero-peer tunnel and showed `VPN: On`. A subsequent stop returned the
menu to disconnected, and the test identity's lock was available for cleanup.
The menu still showed `Peer status unavailable` after about five seconds,
rather than an empty peer list.

The private DHT bootstrap received 16 UDP packets from the Mac during that
zero-peer test; responses and successful bootstrap were not verified then.
A subsequent user-approved LAN test used the same runtime, generated test
identities, a private four-node DHT and a Linux TUN on N5. Linux reported an
authenticated admission and the VPN peer greeting. A Mac TCP connection to a
granted Linux echo port returned its payload; a connection to a denied port
timed out and did not increment that listener's counter. Both listeners had
passed Linux-local controls. The Mac menu showed `Peer status unavailable`
while the Linux peer was connected. A later controlled zero-peer signing
comparison found that adding the profile-authorized macOS application identifier
to the host signature enabled status replies and displayed `No peers configured`.

An earlier user-approved LAN retest used the normal Apple Development-signed build
from commit `a11f91ecfbe0bdcf5b6bc03cebc851baebb95133` and fresh test identities.
The signed host had the application identifier, and systemextensionsctl showed
version 0.1/8 activated and enabled. Linux logged authenticated admission and
`VPN peer connected: mac-test`; the Mac menu showed `VPN: On` and
`linux-test: Connected`. Both Linux TCP listeners passed local controls. The
granted port echoed from Mac and reached a listener count of two (one control,
one Mac); the denied port timed out and remained at one (the local control).

Stopping returned the menu to disconnected and released the test identity lock.
The test identities and fixtures, Linux interface, route, addresses and
listeners were removed; the Mac route returned to its prior default. The test
OS VPN configuration and extension were retained. Three sampled sums of RSS
were 228,216, 281,744 and 276,948 KiB, including the N5 test supervisor and
descendants and the Mac Kepos and KeposTunnel processes. Shared pages may be
counted more than once and peaks between samples were not captured; these are
not sustained-load or leak measurements. Memory was not measured during the
earlier LAN run.

A subsequent user-approved retest used the normal Apple Development-signed build
from commit `0a8c37cf11cc6b68a473baeabbdf52824912b447`; its version 0.1/10
extension was activated and enabled. Linux logged authenticated admission and
`VPN peer connected: mac-test`, while the Mac menu showed `VPN: On` and
`linux-test: Connected`. Both Linux listeners passed local controls; the granted
port echoed from Mac and its count reached two (one control and one Mac). The
denied port timed out and its count remained one (the control). After stop, the
menu showed disconnected, the test lock, identities, routes, TUN and listeners
were cleaned up, and the Mac route returned to its prior default. The OS VPN
configuration and extension were retained.

Short Mac host CPU-time samples for 0.1/10 were 0:00.24 to 0:00.24 over ten
seconds before connection, 0:00.62 to 0:00.67 over five seconds while connected,
and 0:00.18 to 0:00.19 over ten seconds after cleanup and relaunch. The earlier
0.1/8 host had risen from 0:52.26 to 0:56.23 over five disconnected seconds.
These are short observations on one Mac, not battery or leak measurements; no
aggregate RSS was measured for the 0.1/10 run.

A further user-approved LAN test used the Apple Development-signed acceptance
diagnostic build from commit `a5778553def9caab495764183b2d281bb8d30e61`, with
the 0.1/13 extension activated and enabled. An invalid TOML configuration
reached the extension and the menu showed `VPN: Failed`, a fixed recovery
message, and `Configuration changes apply after reconnecting.` After restoring
the temporary valid configuration, the menu showed `VPN: On` and
`linux-test: Connected`; N5 logged authenticated admission and the VPN v1 peer
connection.

For the HTTPS test, a temporary N5 DNS server at `192.168.1.88:49880` returned
`navidrome.n5.guion.io` as `198.18.113.10`. Mac `dig` queried that server
explicitly, and `curl --resolve` used the result on port 43847. With only the
temporary self-signed test certificate trusted through `--cacert`, curl verified
the hostname and received the test HTTPS response. This did not test automatic
system DNS resolution or use production DNS, Caddy, or certificates.

In the Mac accept-direction test, an authorized Linux peer completed an echo
and the Mac listener recorded one acceptance. After stopping the Linux VPN,
TUN, and route, a separate unknown key made a real Noise connection attempt;
the Mac diagnostic log recorded `admission_unknown` at 15:15:44 and the raw
client reported status 0. An authorized raw key produced `admission_accepted`
at 15:16:02. Its IPv4/TCP SYN used the Mac's own test address as a spoofed
source; its checksums were independently validated, and a packet-policy
self-check rejected the spoof and admitted the correct-source control. The Mac
logged `source_mismatch`. A subsequent SYN using the authorized Linux test
address produced `policy_admitted` and `packetflow_write_ok`; the raw client
received the matching SYN-ACK and sent ACK, and the listener recorded a second
acceptance. These are observations at the instrumented boundaries; they do not
prove all possible attack cases.

The raw client exited with status 1 because the operator-side listener-confirmed
flag arrived after its ten-second wait, despite the observed second acceptance
and SYN-ACK/ACK. It was not automatically retried. A Mac-local connection to
the overlay listener also timed out; an initial Python 3.9 timeout exception
ended the listener, and the local control still timed out after the test script
was fixed and the listener remained alive. The reason is unproven; the real
Linux-to-Mac echo was the positive control. The phase-one N5 supervisor later
reached its 600-second timeout, exited 124 and reported its test processes
stopped. Both phases' temporary identity locks, preferences, fixtures, N5
processes, TUN, route and ports were checked as cleaned up. The Mac overlay
route returned to default/en0; the OS VPN configuration and extension remain.
No production firewall was changed.

RSS monitoring showed samples in the hundreds of MiB, below its 900 MiB warning
threshold, but phase-one output was truncated and phase two omitted the Mac
Python listener because of process-name case matching. These samples cannot
establish an exact peak or a hard memory limit.

Another user-approved LAN test used the same signed 0.1/13 diagnostic runtime,
a four-node private DHT and a temporary Linux TUN at `198.18.113.10`; the Mac
peer used `198.18.113.9`. Both peers authenticated and completed the VPN v1
greeting. A temporary user-space Mac `dns-sd -P` Bonjour/mDNS proxy registered
`kepos-acceptance-44137a7.local` for the Linux address, and `dscacheutil`
returned that address as the sole IPv4 result. Without `--resolve` or
`--connect-to`, Mac curl used the system resolver and accessed the test HTTPS
endpoint on port 43847, trusting only the generated self-signed test certificate
with `--cacert`; it received the expected response. This verifies system
resolution of that test `.local` name and HTTPS over this VPN path, not system
resolution of `navidrome.n5.guion.io` or production certificates or Caddy. No
system or production DNS settings were changed.

After disconnect, the test verified the Mac identity lock, terminated the exact
`dns-sd` process and confirmed registration process exit, and removed temporary
identity and preferences. The N5 supervisor was terminated using verified PID
and start time, exited 143, and its children and recorded TUN, route, UDP and
TCP ports were checked as cleaned up. Both fixture roots were removed and the
Mac overlay route returned to default/en0. The existing Kepos VPN configuration
and 0.1/13 extension were retained. The first part of the RSS monitor output
showed a peak of at least 362,404 KiB; every sample was below the 900 MiB warning
threshold. Samples summed the Mac app, provider and `dns-sd` with N5 supervisor
descendants; shared pages may be counted twice and peaks between samples missed.
They are not an exact memory limit or a leak test. The LAN tests do not establish
NAT traversal, relay, mobile networks, iOS or production readiness.

A subsequent user-approved direct-peer LAN test used the ordinary build from
`a5778553def9caab495764183b2d281bb8d30e61`, without acceptance diagnostics.
The N5 arm64 build archive SHA-256 was
`e5c9228485e1b25ac78ffa6899324b802e2512a167803c079c6c1830052f391c`;
the Mac app was signed and verified with an Apple Development profile, and its
0.1/15 extension was activated and enabled. The test reused the approved plan
with fresh identities, four private DHT nodes, a root-owned test TUN and Mac
and N5 overlay addresses `.9` and `.10`. N5 logged authenticated admission
and the VPN v1 peer connection. Mac TCP port 43845 echoed; ungranted port
43846 timed out. N5 listener counts were two for the allowed port (local and
Mac) and one for the denied port (local only).

Initially the Mac menu showed `VPN: On` and `linux-test: Disconnected`, then
the menu process disappeared. AppKit logs showed that the process received a
terminate request and exited normally; the reason and initiator are unknown.
The VPN provider continued running, and after reopening the menu it displayed
`VPN: On` and `linux-test: Connected`. This observes reattachment, not the
cause of the earlier exit. After stopping, the menu showed disconnected; test
identities, lock and preferences were removed. The N5 supervisor exited 143
after TERM and its children, TUN, routes and ports were verified cleaned up.
The Mac route returned to default/en0; the existing OS VPN configuration and
0.1/15 extension were retained, and the app was reopened. The 0.1/13 app backup
was retained. RSS sampling observed at least 334,720 KiB, below the 700 MiB
warning threshold; shared pages may be counted twice and peaks between samples
missed. This ordinary-build test covered allowed and denied TCP and reattached
status; the unknown-key, spoof and HTTPS observations above used the 0.1/13
diagnostic build. No production DNS, Caddy, NAT, relay or iOS test was performed.

`npm run macos:test` runs the platform-independent Swift menu, local bridge,
and read-only identity tests. `npm run macos:build` creates an unsigned arm64
app and app-extension bundle at `.build/macos-unsigned`; it refuses to
replace an existing output. Set `KEPOS_TEAM_ID` to the intended ten-character
Apple team identifier and, if needed, `KEPOS_BUNDLE_ID` to the intended app
identifier. A placeholder team ID can be used for build inspection only.

The build expects the macOS slice of the official BareKit v2.5.5
`prebuilds.zip` at `.build/macos-deps/BareKit.xcframework`. The complete
release archive's published SHA-256 is
`fc68740347c8532ba49d45bf61fae9ca1f1040dc7d6c99f2f92dc30c40e84e46`;
verify the complete archive against the release metadata before extracting the
`darwin/BareKit.xcframework` directory. Selectively downloading archive ranges
does not verify that full-archive digest. The archive is approximately 399 MiB
and its extracted macOS directory approximately 266 MiB. The build uses the
root npm workspace and, on Linux, the configured Swift Darwin SDK and the
workspace's macOS-capable LLVM linker. The generated host entitlements include
`com.apple.application-identifier` with the selected team and bundle identifier;
the host provisioning profile must authorize that claim. The generated
entitlement files are signing inputs, not evidence of an authorized capability
or a signed bundle.

Actual development signing, profile selection, installation, activation and
Mac-to-Linux testing require a separate reviewable plan and isolated test
identities and configuration. Do not use a real identity, live VPN, production
service, or existing user VPN configuration as a test fixture. DNS and Caddy
remain external to Kepos.

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
