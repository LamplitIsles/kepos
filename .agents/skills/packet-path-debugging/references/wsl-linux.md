# WSL and Linux Packet-Path Reference

Use this reference for WSL mirrored/NAT networking, Linux namespaces, systemd services, and ephemeral UDP sockets.

## Inventory

- Record WSL mode with `wslinfo --networking-mode` when available.
- Inspect interfaces with `ip -details link show` and `ip -br address show`.
- Resolve the actual route using `ip route get PEER_ADDRESS`; inspect policy rules with `ip rule show` and all tables with `ip route show table all`.
- Resolve UDP sockets and processes with `ss -uapne`; do not assume a service PID or port survived a restart.
- Read the bounded service window with `journalctl --user -u UNIT --since TIME --until TIME`.
- Record route/interface counters before and after the stimulus.

Mirrored WSL can share Windows addresses while still traversing Hyper-V filtering and virtual switching. Treat WSL and Windows as adjacent observable boundaries, not as one host.

## Capture

1. Check `sudo -n true` before starting; stop if noninteractive capture permission is unavailable.
2. Capture on `any` for discovery, then narrow to the route-selected interface when proving a boundary.
3. Use `timeout --signal=INT` for bounded `tcpdump` sessions.
4. Do not filter on a fixed DHT/listener port alone. Include the peer or discover current ephemeral sockets first.
5. Keep `tcpdump` stderr because received/dropped counts affect whether absence is evidence.
6. Run one failing trial and one successful control with the same capture path; repeat failures when claiming a stable boundary.

## Interpretation

- A packet on WSL egress but not on an adjacent Windows capture bounds the loss to WSL/Hyper-V/Windows; it does not name the Hyper-V firewall.
- A successful reverse flow proves only its own directional NAT and firewall state.
- A private destination routed to the default gateway is route evidence, not proof that the destination host rejected the packet.

Keep raw captures under a private temporary directory and publish only redacted labels, UTC times, filters, counters, hashes, and packet-shape correlations.
