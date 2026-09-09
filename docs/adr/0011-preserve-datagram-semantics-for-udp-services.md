# Preserve datagram semantics for UDP services

Kepos's UDP extension will expose named, fixed-destination unicast services
while retaining the existing device identity and service authorization model.
Use an encrypted unordered datagram path rather than framing UDP over the
reliable service stream: the latter preserves packet boundaries but makes a
lost packet delay later packets, undermining the real-time application goal.
This is an accepted design direction, not a claim that UDP support is implemented.

The first real application acceptance case is Stardew Valley direct-IP play.
The initial delivery and required platform verification are desktop-only.
WebRTC/TURN integration and virtual-LAN discovery are outside this slice.

The existing SecretStream unordered-message API is the implementation
candidate. Its usable payload budget and supported carrier behavior must be
verified before declaring compatibility; the earlier 1024/1200-byte proposals
are not established application limits or proof that Stardew Valley works.
If an application datagram exceeds the safe carrier budget, assess bounded
fragmentation and reassembly against actual application requirements rather
than silently switching to reliable ordered transport. A lost fragment may
lose its datagram; later complete datagrams must not wait for it.

See [the UDP design and compatibility boundaries](../native-udp-design.md)
for acceptance scope, WebRTC/TURN reachability, and unverified assumptions.
