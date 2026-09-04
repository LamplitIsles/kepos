# Mac to kosmos transport evidence

Dates: 2026-07-17, 2026-07-18, and 2026-07-22

The first section records the current persistent Protomux runtime. Later
sections retain the earlier one-process-per-service Hypertele evidence for
history.

## Persistent multiplex proof

Source commit: `7b9f7b9`.

The current isolated-DHT suite and the 2026-07-18 Mac-to-kosmos-wsl sample
prove:

- one subscriber connection carries Home, a Navidrome-like HTTP stream, and
  a real OpenSSH session;
- each actual TCP connection has an independent Protomux channel;
- closing one channel does not close the publisher connection;
- one publisher accepts several allowlisted subscribers concurrently;
- an unknown subscriber is rejected before entering the mux;
- publisher restart triggers background subscriber reconnect without changing
  local Home or service ports;
- active TCP stream recovery after a dropped outer connection remains
  deferred.

### Hostname gateway to WSL Navidrome

On 2026-07-20, the current branch was copied to
`/home/neil/.local/share/kepos-neo-mux` on kosmos-wsl. A new publisher state
exposed WSL Navidrome at `127.0.0.1:4533`; a new Mac subscriber state used the
default local gateway port without a raw Navidrome listener.

Two attempts through HyperDHT's built-in bootstrap set ended with
`HOLEPUNCH_ABORTED` after 7.04 and 14.93 seconds. With the four locally
validated CN, HK, SG, and US bootstrap endpoints configured on both sides, the
outer connection completed in 2.48 seconds. The successful transport snapshot
reported a public IPv4 endpoint and roughly 438–456 ms RTT.

The Mac then used the hostname gateway:

| Request | Result | First byte | Total |
| --- | --- | ---: | ---: |
| `http://home.localhost:17480/` | HTTP 200, 2,863 bytes | 1.010 s | 1.012 s |
| `http://navidrome.localhost:17480/ping` | HTTP 200 | 1.466 s | 1.467 s |
| `http://navidrome.localhost:17480/` | HTTP 302 | 1.455 s | 1.455 s |
| Navidrome root with redirect followed | HTTP 200, 2,507 bytes | 1.470 s | 1.472 s |
| repeated Navidrome `/ping` | HTTP 200 | 1.428 s | 1.428 s |

Concurrent Home and Navidrome requests opened separate `home` and
`navidrome` channels with the same subscriber `outerId`. The publisher also
reported one accepted outer connection and the matching service channels.
This proves hostname routing and service multiplexing without another
HyperDHT handshake or one subscriber process per HTTP service.

A 16 MiB Home benchmark through the same gateway returned HTTP 200 in 5.91
seconds. Curl's end-to-end rate was 2.84 MB/s; channel observations measured
about 4.06 MB/s after first byte. The transient publisher and subscriber were
stopped after the sample. The existing dogfood systemd publisher remained
active and unchanged.

This first hostname sample was later found to be affected by the Mac Clash
TUN. The Kepos Node process did not yet have a process-path bypass, so Mihomo
matched its UDP traffic as `漏网之鱼` and sent it through a Singapore proxy.
The hostname routing, multiplexing, HTTP results, and transferred bytes remain
valid functional evidence. The 438–456 ms RTT, request latency, throughput,
hole-punch behavior, and bootstrap comparison are not a clean direct-path
baseline.

### Clash-DIRECT retest with Home, Navidrome, and SSH

The Mac Clash source and generated configuration were updated to route the
exact Node 22 executable used by Kepos through `PROCESS-PATH,DIRECT`. Live
Mihomo connections for the publisher endpoint and DHT peers then reported
`ProcessPath` with a single `DIRECT` chain instead of a proxy group.

The current publisher exposed Navidrome on WSL loopback port 4533 and OpenSSH
on WSL loopback port 22. One Mac subscriber exposed the hostname gateway on
17480 and SSH on 2222. Home, Navidrome, and a real OpenSSH command all used
the same outer ID.

| Operation | Result | Time |
| --- | --- | ---: |
| Home | HTTP 200 | 0.180 s |
| Navidrome `/ping` | HTTP 200 | 0.180 s |
| OpenSSH command to `kosmos-wsl` | success | 0.924 s |
| 16 MiB Home benchmark | HTTP 200, 7.40 MB/s | 2.267 s |

The outer connection completed in 4.70 seconds and settled around 84–93 ms
RTT during the SSH sample. This is the first Mac-to-kosmos-wsl measurement in
this document that is verified as Clash `DIRECT`. It still passes through the
enabled Clash TUN before the `DIRECT` rule; it does not pass through a Clash
proxy node.

### LAN `auto`

The publisher and subscriber both ran on the Mac with the normal public
HyperDHT bootstrap. `auto` selected a private-address path. Discovery and the
first handshake took 9.58 seconds, but the persistent connection then served
two Home requests without another outer handshake:

| Request | HTTP | First byte | Total |
| --- | ---: | ---: | ---: |
| Home health | 200 | 11 ms | 12 ms |
| repeated Home health | 200 | 5 ms | 5 ms |

The slow first connection and fast channels are separate facts: LAN transport
does not make first-time DHT discovery instant.

### Non-local `public`

The publisher ran on kosmos-wsl with Node 22.20.0. The Mac subscriber used
`--route public`, which disables HyperDHT's LAN shortcut. The sanitized
snapshot showed a public IPv4 endpoint; this does not prove a relay or fixed
route. The one outer handshake took 2.47 seconds.

| Service | Result | First byte / command time |
| --- | --- | ---: |
| Home health | HTTP 200 | 1.03 s |
| repeated Home health | HTTP 200 | 0.94 s |
| Navidrome `/ping` | HTTP 200 | 1.04 s |
| OpenSSH command | `public-mux-ssh-ok` | 4.55 s |

All channel events in this run shared one outer ID. The publisher emitted one
`outer.accepted` and one `outer.connected`; opening Home twice, Navidrome, and
SSH did not create more DHT handshakes.

The first SSH attempt was dropped by the target sshd before key exchange.
The sshd journal reported a temporary `PerSourcePenalties` /
`exceeded LoginGraceTime` drop for its loopback source. A retry through the
same Kepos path completed a real OpenSSH command, so that first failure is not
attributed to the mux.

### Reconnect with stable listeners

The publisher was stopped while the subscriber stayed up. The subscriber
reported `outer.closed`, four failed recovery attempts, and
`outer.restored` on recovery attempt 5 after 45.05 seconds. The same local
ports remained bound:

- Home: the original generated URL returned HTTP 200 in 1.14 seconds;
- Navidrome: `127.0.0.1:14533/ping` returned HTTP 200 in 1.14 seconds;
- SSH: `127.0.0.1:2222` returned `mux-ssh-after-reconnect-ok`.

This is one acceptance sample, not a latency baseline. Route discovery and NAT
conditions vary. The migration adds no transport gzip: Home/HTTP and
Navidrome already have application-level compression choices, while SSH is
encrypted and media payloads are generally incompressible.

### Silent-path recovery and one subscriber identity

On 2026-07-22, the updated publisher was deployed first to the existing
kosmos-wsl transient user service. The Mac then started the updated subscriber
with its existing identity and listeners. Its outer connection selected the
LAN endpoint and completed in 1.79 seconds. Home, Navidrome `/ping`, and a real
OpenSSH command all succeeded through that one outer connection.

While that subscriber was running, a second CLI process tried to use the same
state directory. It exited before connecting with `Subscriber identity is
already in use`; the owner-only lock lived beside the strict state directory,
not among its identity files.

To model a path that silently stops carrying packets, kosmos-wsl dropped
outbound UDP to the Mac for 45 seconds. The existing HyperDHT stream reported
`connection timed out` about 35 seconds after packet loss began, just before or
at the same threshold as the application heartbeat. The subscriber kept the
same process and localhost listeners, discarded that outer, retried in the
background, and reported `outer.restored` on a new outer 38.62 seconds after
the close. The publisher closed the old outer before accepting the restored
one.

After the temporary firewall rule had been removed, Home, Navidrome, and SSH
all succeeded again through the original local ports. The firewall rule was
verified absent. This sample proves recovery from a silent UDP path and stable
local listeners. The focused transport tests separately force the heartbeat
timeout itself; in a real HyperDHT stream, its own timeout can win the race.

### Real Mac network switch

The same Mac subscriber was then left running while the Mac slept, woke, and
moved from a `192.168.31.0/24` Wi-Fi network to a `192.168.1.0/24` Wi-Fi
network. The subscriber process, state directory, identity, and localhost
listeners were not restarted or replaced. macOS published the new IPv4 path
at 22:01:43.556; the publisher accepted the new outer at 22:01:57.020. That is
13.46 seconds from the network-change event, or 11.74 seconds from macOS
reporting the DHCP lease fully bound. Its prior outer had already closed, and
the new outer reached the same publisher through a public IPv4 endpoint. The
publisher did not retain two active sessions for that subscriber identity.

After recovery, the original local ports still served all three paths:

| Operation | Result | Time |
| --- | --- | ---: |
| Home | HTTP 200 | 39 ms |
| Navidrome `/ping` | HTTP 200 | 31 ms |
| OpenSSH command | success | 468 ms |

This proves recovery across a real Mac sleep/wake, interface path, and address
change without restarting the subscriber or its local services. It does not
prove migration of TCP streams that were already open when the network
changed; callers may need to retry those streams over the restored outer.

### Migration provenance

The route mapping, connection/retry timing, sanitized DHT snapshots,
first-byte and byte-count metrics, transfer-rate calculation, and close-source
observations were adapted from the Hypertele fork at
`cdb851bf750369d5b9eaead3975580e8459fe025` on
`feat/kepos-transport-spike`.

The raw probe was not migrated: an open HyperDHT stream describes transport
connectivity, while a successful Protomux `open-ok` describes acceptance of a
specific service. A stronger application-health protocol is deferred until
field evidence shows that those states are insufficient.

The persistent outer connection, Protomux service protocol, publisher
allowlist, shared runtime, and state model are Kepos-specific. The migration
audit and upstream provenance are in `docs/hypertele-provenance.md`.

## Earlier public-path proof

```text
Mac ssh/scp
  -> 127.0.0.1:2222
  -> Hypertele client service `ssh`
  -> public HyperDHT
  -> kosmos Hypertele publisher service `ssh`
  -> kosmos-wsl 127.0.0.1:22
```

Home stays available through a second Hypertele process. Both Mac processes
use the same client identity. Home and SSH use distinct publisher seeds and
service keys with one shared allowlist.

## Public identifiers

- Mac client key:
  `ce712ee54158ca783ba679763774c5ea4cbea6f18108630af6483c8485c35d71`
- kosmos Home key:
  `6b8da9a3d91aa13f7f6b1ee66b5a15d8adce9cf16936f3dd8be81391b6acfc55`
- kosmos SSH service key:
  `b644a8297cb0762f672baa9967d189b15a94d01180340ef408072a123ada7d15`

No seed or client secret is recorded here.

## Automated proof

`test/dogfood-smoke.test.ts` uses an isolated three-node HyperDHT testnet. It
proved:

- Home HTML and Registry cross the Home tunnel.
- TCP bytes cross the second service tunnel.
- one client identity opens both tunnels;
- publisher state and public keys remain stable across repeated setup;
- all child processes and listeners close cleanly.

## Historical real kosmos proof

The publisher was copied through the existing `ssh nuc` path and started as
the enabled `kepos-dogfood-publisher.service` user unit. The unit publishes:

- Home from a random loopback HTTP port;
- `ssh` to the existing loopback-only kosmos-wsl sshd on port 22.

The Mac client fetched the Registry through Home and opened SSH at
`127.0.0.1:2222`.

Command-mode SSH returned:

```text
kosmos-wsl
neil
active
```

SCP copied `package.json` through the tunnel. The local and remote SHA-256
values were identical:

```text
a3aab0230bd1d8afa8bf73ac253046caef30062e42bb72623342ec31fe575f2c
```

Restarting the publisher kept the same Home and SSH service keys. The existing
Mac client reconnected and a new SSH command returned:

```text
restart-ok
kosmos-wsl
```

Removing the Mac key from both publisher allowlists and restarting caused SSH
through port 2222 to close. Restoring the key and restarting restored access:

```text
revocation-ok: SSH access denied after allowlist removal
restore-ok
kosmos-wsl
```

The systemd unit uses `KillMode=mixed`. This sends the normal stop signal only
to the supervisor, while still letting systemd kill the whole control group if
the supervisor cannot finish shutdown. The default control-group mode sends
SIGTERM directly to each Hypertele child and bypasses clean shutdown.

## Windows public-path observability spike

A later spike moved the publisher side to Windows on the NUC:

```text
Mac HTTP
  -> 127.0.0.1:17480
  -> Hypertele client with `--route public`
  -> public HyperDHT direct UDP path
  -> Windows Hypertele server
  -> Windows Home on 127.0.0.1
```

The Windows Home key remains
`6b8da9a3d91aa13f7f6b1ee66b5a15d8adce9cf16936f3dd8be81391b6acfc55`.
Its separate Windows SSH key is
`38c63a7d22a6d0531f2a81e4f741c45753a01446c193b558e62606768292cb4c`.
No seed or private key is recorded here.

Hypertele now records connection attempts, DHT and Noise handshake time,
readiness-probe time, first-byte time, transfer time, byte counts, and
effective transfer rate. It retries a failed handshake or readiness probe
before consuming the pending local TCP request. The observed samples all
succeeded on their first application-level attempt, so retry behavior is
proved by automated tests rather than by a forced live failure.

The final samples forced `--route public`. They reached the Windows peer at
public address `125.110.47.243`, and HyperDHT reported zero relay attempts.

| Sample | DHT handshake | Probe | Home first byte after ready | Transfer | Established rate | Total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| health, cold | 2.37 s | 15 ms | 18 ms | — | — | 2.41 s |
| health, one-second gap | 16 ms | 9 ms | 8 ms | — | — | 34 ms |
| health, four-second gap | 4.19 s | 416 ms | 826 ms | — | — | 5.43 s |
| 16 MiB, cold | 6.59 s | 445 ms | 1.58 s | 4.78 s | 3.51 MB/s | 13.39 s |
| 64 MiB, cold | 5.11 s | 441 ms | 2.42 s | 16.31 s | 4.11 MB/s | 24.28 s |

The aggregate curl rates, which include setup and first-byte delay, were
1.25 MB/s for 16 MiB and 2.76 MB/s for 64 MiB.

HyperDHT keeps a reusable UDP route for three seconds after a connection
closes. This matches the observed 34 ms request after a one-second gap and the
return to multi-second setup after a four-second gap. Its
`connectionKeepAlive` setting applies to a connection that is still open; it
does not extend this route-cache window.

The main delay is public route discovery and hole punching, not steady-state
transfer. Once established, this path moved large responses at roughly
3.5–4.1 MB/s in the final forced-public samples.

## Deployment status

The earlier live kosmos deployment was deliberately transient:

- source: `/home/neil/.local/share/kepos-neo-dogfood`
- legacy publisher state: `/home/neil/.local/state/kepos-neo/publisher`
- user unit: `kepos-dogfood-publisher.service`

That legacy state is not compatible with the persistent multiplex runtime. Its
manifest uses `homeConfig` and per-service config files, while the current
runtime requires `publisherConfig` and exactly two state files. A new
deployment should use a separate state directory:

```text
~/.local/state/kepos-neo/mux-publisher
```

Initialize it once before starting the WSL-owned service:

```sh
cd ~/.local/share/kepos-neo-dogfood
export MAC_SUBSCRIBER_PUBLIC_KEY='<64-character-lowercase-hex-key>'
npm run kepos -- setup publisher \
  --state ~/.local/state/kepos-neo/mux-publisher \
  --display-name kosmos-wsl \
  --subscriber-device "mac:$MAC_SUBSCRIBER_PUBLIC_KEY" \
  --service ssh:SSH:22 \
  --service navidrome:Navidrome:4533
```

Kepos no longer ships or maintains that systemd unit. The WSL or kosmos
configuration owns process supervision and should run:

```sh
npm run kepos -- publisher run \
  --state ~/.local/state/kepos-neo/mux-publisher
```

This document does not claim that a WSL-owned replacement unit and the new
state directory have been deployed yet.

FlickNote orientation note `1342` records the exact NixOS and agenix follow-up.
The permanent change needs the authoritative kosmos repo, which is not present
on kosmos-wsl.
