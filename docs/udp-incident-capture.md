# Kepos UDP incident capture

Use this runbook only while a subscriber cannot connect to its paired
publisher. Capture before restarting either side: a capture taken after the
connection has recovered can prove the healthy path, but cannot explain the
outage.

Keep every capture directory private. Do not commit PCAP files, addresses,
routes, hostnames, peer IDs, or raw `tcpdump` output.

## 1. Start both captures

On the macOS subscriber, create the private directory and start the capture:

```sh
umask 077
CAPTURE_DIR=$(mktemp -d "${TMPDIR:-/tmp}/kepos-udp-mac.XXXXXX")
chmod 700 "$CAPTURE_DIR"
printf '%s\n' "$CAPTURE_DIR"
sudo /usr/sbin/tcpdump -i pktap,all -nn -s 0 -w "$CAPTURE_DIR/mac.pcap" udp
```

`pktap,all` sees the selected macOS packet path without assuming that a
physical interface, bridge, tunnel, or VM interface carries the traffic.
`-s 0` is required here: a small snap length can be consumed by the `pktap`
metadata and leave the UDP header unparseable.

If `pktap,all` is unavailable, first run `sudo /usr/sbin/tcpdump -D`, then
capture the route-selected physical interface and each plausible bridge or
tunnel separately. Do not substitute a guessed interface.

On the Linux publisher, start a matching capture:

```sh
umask 077
CAPTURE_DIR=$(mktemp -d /tmp/kepos-udp-linux.XXXXXX)
chmod 700 "$CAPTURE_DIR"
printf '%s\n' "$CAPTURE_DIR"
sudo tcpdump -i any -nn -s 0 -w "$CAPTURE_DIR/linux.pcap" udp
```

Wait until both commands are recording. Record the exact UTC time immediately
before the stimulus:

```sh
date -u '+stimulus_utc=%Y-%m-%dT%H:%M:%SZ'
```

Then reproduce the failure once. If a restart is required to reproduce it,
restart only after both captures are active. Keep recording for 60--90 seconds
after the result, then stop each command with `Ctrl-C`. Retain the received and
dropped packet counters printed by `tcpdump`.

## 2. Preserve only the evidence needed

If analysis must happen from another account, change ownership of the two
exact PCAP files, not their parent temporary directories. For example:

```sh
sudo chown "$USER" "$CAPTURE_DIR/mac.pcap"
```

After extracting a redacted conclusion, delete only the exact capture
directory created for this incident. Never use a broad temporary-directory
cleanup command.

## 3. Correlate the two sides

Compare the same UDP flow by UTC time, direction, packet length, burst order,
and safe transaction identifiers. NAT can rewrite source address, source port,
and checksums, so a literal five-tuple match is not required.

Use this evidence table in the incident record. Replace `present` or `absent`
only after checking that both captures cover the stimulus and have acceptable
drop counters.

| Mac egress | Linux ingress | Publisher outer handshake | Narrow conclusion |
| --- | --- | --- | --- |
| present | present | present | UDP path and Kepos transport worked for this trial. |
| present | absent | absent | Boundary is between the two capture points; the dropping component is unknown. |
| present | present | absent | UDP reached both hosts; inspect pairing, discovery, and transport logs. |
| absent | present | any | Capture coverage or flow matching is invalid; investigate before concluding. |
| absent | absent | absent | No boundary is proven without a valid control flow. |

An authenticated `outer.accepted` / `outer.connected` event on the publisher
is stronger evidence than an open UDP socket. Conversely, a failed TCP or SSH
probe does not prove UDP loss.

## 4. What the 2026-08-27 trial established

The controlled restart trial established a healthy direct path: the old outer
closed at the stimulus, the publisher accepted and connected a new outer about
eight seconds later, and both captures showed bidirectional UDP activity. The
publisher then served channels successfully.

That trial did **not** reproduce the earlier long outage. Its root cause remains
unknown; the next occurrence must follow this runbook without restarting first.
