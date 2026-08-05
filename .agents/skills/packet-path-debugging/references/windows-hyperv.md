# Windows and Hyper-V Packet-Path Reference

Use this reference for Windows routing, mirrored WSL, Hyper-V firewall policy, `pktmon`, and the boundary between WSL and a physical adapter.

## Inventory

- Run `Get-NetAdapter -IncludeHidden`, `Get-NetIPConfiguration -All`, `Get-NetRoute`, and `Get-NetUDPEndpoint` in PowerShell.
- Record `route.exe print`, `wsl.exe --status`, and `wsl.exe --list --verbose`.
- Read Hyper-V policy with the installed `Get-NetFirewallHyperVVMSetting` and `Get-NetFirewallHyperVRule` commands. Inspect actual direction, protocol, local ports, action, enabled state, and profile; a display name is not evidence.
- Snapshot adapter counters before and after the stimulus.

These commands are read-only. Do not create, widen, disable, or rename firewall rules during diagnosis.

## Capture

1. Run `pktmon help`, `pktmon start help`, and `pktmon status` before using it.
2. Do not stop or replace a capture session that this case did not start.
3. Prefer a bounded `pktmon` capture across relevant components; record counters before stopping the session.
4. Convert ETL to PCAPNG locally only when needed for correlation.
5. If this Windows build lacks the required `pktmon` form, inspect `netsh trace show status` before using a bounded nonpersistent trace.
6. Record the exact components/interfaces covered, UTC window, snap length, filters, and capture loss.

## Boundary Rule

Require simultaneous captures on both adjacent sides, a correlated packet upstream, no correlated packet downstream, acceptable capture-loss counters, and a visible successful control downstream. Without all of these, report `boundary not proved`.

Do not write “Hyper-V firewall dropped the packet” unless firewall logging/counters or a component-level drop event identifies it. Windows capture absence only narrows the boundary.

Raw ETL/PCAPNG, adapter identifiers, MAC addresses, routes, usernames, and public addresses stay in a private temporary case directory. Durable reports use labels and hashes.
