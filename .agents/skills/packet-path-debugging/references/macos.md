# macOS Packet-Path Reference

Use this reference for macOS hosts, `pktap`, Apple VM bridges, OrbStack, and dynamic UDP sockets.

## Inventory

- Map hardware ports with `networksetup -listallhardwareports`.
- Read active network state with `scutil --nwi`.
- Inspect every interface with `ifconfig -a` and routes with `netstat -rn`.
- Resolve the selected path with `route -n get PEER_ADDRESS`.
- Attribute a bridge with `ifconfig BRIDGE_NAME`; inspect its member interfaces and then the owning VM/container process or product configuration.
- Resolve UDP owners live with `lsof -nP -iUDP` and confirm the process using `ps -p PID -o pid=,command=`.

Do not assume `bridge100`, `utunN`, `vmnetN`, or `vmenetN` is the physical path. macOS physical Wi-Fi is commonly `en0`, but inventory is authoritative.

## Capture

1. Run `/usr/sbin/tcpdump -D` before choosing an interface.
2. Prefer `pktap,all` when available; otherwise capture the route-selected physical interface and each plausible bridge/tunnel separately.
3. Test noninteractive permission with `sudo -n /usr/sbin/tcpdump -D`. Never leave an unattended password prompt.
4. Use numeric output, a bounded duration, a short snap length, and a filter broad enough to include ephemeral UDP sockets.
5. Record `tcpdump` received/dropped counts and the exact UTC stimulus time.

If capture permission is unavailable, collect inventory and counters but mark the Mac-side arrival boundary unproved. Evidence from the other host cannot prove absence on an uncaptured Mac interface.

## Safe Template

- Create the case directory with `CASE_DIR=$(mktemp -d "${TMPDIR:-/tmp}/packet-path.XXXXXX")` and `chmod 700 "$CASE_DIR"`.
- Start only a bounded capture and record its PID.
- Stop that PID with `kill -INT CAPTURE_PID`, then `wait CAPTURE_PID`.
- Summarize locally with `tcpdump -tttt -nn -e -r CAPTURE.pcap udp`.
- Remove only the exact validated case directory after the durable redacted summary exists.

Never persist raw `ifconfig`, `lsof`, route, or capture output in a public issue.
