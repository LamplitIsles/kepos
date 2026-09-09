# Preserve datagram semantics for UDP services

Status: accepted and implemented for the desktop bounded UDP service path.

Kepos's UDP extension exposes named, fixed-destination unicast services while
retaining the existing device identity and service authorization model.
Use an encrypted unordered datagram path rather than framing UDP over the
reliable service stream: the latter preserves packet boundaries but makes a
lost packet delay later packets, undermining the real-time application goal.
The implementation uses the same authenticated SecretStream/UDX outer
connection as TCP and does not create a Protomux data channel or new DHT/Noise
connection per UDP service or flow. Android presentation and runtime support
remain intentionally excluded.

The first real application acceptance case is Stardew Valley direct-IP play.
The initial delivery and required platform verification are desktop-only.
WebRTC/TURN integration and virtual-LAN discovery are outside this slice.

The existing SecretStream unordered-message API is the implementation path.
Its message format adds 24 bytes. libudx's 1200-byte baseline is a complete
packet budget, not an application-message budget; after worst-case IPv6/network
and Kepos overhead the mathematical ceiling for one unfragmented envelope is
1021 bytes. The implementation therefore bounds each carrier fragment to 1000
bytes and supports application datagrams up to 1200 bytes through at most two
bounded fragments. Neither that limit nor a successful echo establishes Stardew
Valley compatibility. A lost fragment may lose its datagram; later complete
datagrams must not wait for it, and no retransmission is added.

See [the UDP design and compatibility boundaries](../native-udp-design.md)
for the delivered scope, WebRTC/TURN reachability, payload arithmetic, and
unverified game assumptions.
