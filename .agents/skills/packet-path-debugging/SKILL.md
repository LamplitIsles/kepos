---
name: packet-path-debugging
description: Use when debugging asymmetric, intermittent, or cross-platform packet loss involving UDP, NAT, hole punching, WSL, Hyper-V, macOS, virtual bridges, VPN interfaces, or packets that leave one host but may not reach another.
---

# Packet Path Debugging

## Overview

Locate a proven packet-loss boundary before naming a cause or fix. Treat candidates, reverse-path success, and absence as evidence—not conclusions. Remain read-only unless authorized.

## Workflow

1. Freeze the case: record direction, UTC action time, packet, process, and configuration. Resolve PIDs and sockets live.
2. Map physical and virtual interfaces, their owners, route-selected gateways, subnets, and NAT boundaries. Private addresses do not imply a shared LAN.
3. Separate fixed listeners, control sockets, and ephemeral data sockets. Never filter or forward only a documented listener unless capture proves the data uses it.
4. Capture adjacent boundaries simultaneously around one controlled failure. Include a successful control on the same interfaces and filters when possible. Record capture-loss counters.
5. Correlate by time, direction, length, burst order, and safe transaction IDs. NAT may rewrite addresses, ports, and checksums.
6. State the narrowest verdict. Packet absence bounds loss only when capture coverage and controls prove it; it does not name the dropping component.
7. When root cause remains unknown, list the missing adjacent capture or topology fact and stop before remediation.

Load only the relevant references:

- macOS and Apple VM bridges: [references/macos.md](references/macos.md)
- WSL and Linux: [references/wsl-linux.md](references/wsl-linux.md)
- Windows and Hyper-V: [references/windows-hyperv.md](references/windows-hyperv.md)

## Evidence Gate

| Evidence | Permitted conclusion |
|---|---|
| Packet leaves A | Failure follows A's emission |
| Packet absent at B without a valid control | Boundary unproved |
| Simultaneous A/B captures, valid control, acceptable capture loss | Loss lies between A and B |
| Traceroute follows a default gateway | Route selection lacks a more specific path |
| Reverse direction succeeds | Only that directional state is proven |
| Interface is advertised | Candidate exists; reachability is unknown |

Example: “Three trials: seen on WSL, absent on adjacent Windows; control visible on both, no capture loss. Boundary: WSL→Windows. Dropping component: unknown.”

## Privacy and Cleanup

- Use a private temporary directory with `umask 077`; never capture in the repository.
- Keep PCAP, ETL, addresses, routes, MACs, usernames, and hostnames out of durable notes and public issues.
- Publish redacted labels, times, filters, counters, hashes, and an evidence table.
- Track every capture PID/session; stop only sessions created for the case.
- Delete only the validated exact temporary directory after extracting evidence.

## Common Mistakes

- Disabling a virtual bridge before proving another candidate reachable.
- Forwarding a fixed listener while data uses ephemeral sockets.
- Recommending relay merely because direct punching failed.
- Calling packet absence a firewall drop.
- Treating ping, traceroute, TCP, and UDP as equivalent proof.

## Output Contract

Report topology, stimulus, capture coverage, evidence, proven facts, unproven claims, root cause or `unknown`, and the next missing read-only observation. Offer fixes only after root cause is evidenced.
