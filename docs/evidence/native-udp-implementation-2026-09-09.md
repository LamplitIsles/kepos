# Native UDP implementation evidence — 2026-09-09

This record describes the bounded desktop UDP service implementation. It is
not a Stardew Valley compatibility claim.

## Automated repository evidence

The test-owned Node runtime exercises real loopback UDP sockets and a
HyperDHT testnet. It verifies:

- versioned envelope encoding/decoding, zero-length payloads, malformed input,
  service-ID validation, payload limits, and bounded fragment reassembly;
- desktop endpoint presentation without a browser-open action, truthful
  missing mappings, and Android's explicit TCP/HTTP-only filtering;
- fixed loopback target and reply-source checks, per-flow reply isolation,
  authorization before target socket creation, and unordered carrier
  forwarding;
- concurrent UDP and TCP over one tracked authenticated outer connection;
- service ACL denial and revocation, flow cleanup, outer replacement, and
  recovery at the same retained subscriber-local UDP listener.

The focused command is:

```sh
env -u XDG_STATE_HOME node --import tsx --test test/native-udp.test.ts
```

The implementation also passes the root and desktop TypeScript checks. The
full repository test command passes with 509 tests: 503 passed, 6 skipped,
and 0 failed. Coverage is run with one test worker because the integration
suite shares local network resources; it passes the same 509 tests with 95.17%
line coverage, 83.08% branch coverage, and 93.09% function coverage. The
checked-in command is:

```sh
env -u XDG_STATE_HOME npm run test:coverage
```

The web verification also passes its production build, 19 web tests, and
Biome check. The focused native-UDP command above passes 9/9 tests.

## Native Windows Bare verification

Owner verification ran the reviewed implementation commit
`c4ca3eb1365e6ba219c1dc14c206f1e68085e8bf` on native Windows
`DESKTOP-93HLACG` using standalone Bare 1.32.0 from
`bare-runtime-win32-x64@1.32.0`. The probe compiled the actual desktop runtime,
used a test-owned HyperDHT loopback testnet, called the real publisher and
subscriber setup/start paths, and used test-owned Bare UDP/TCP echo endpoints.
Fresh temporary state was removed in `finally`; no installed application,
credentials, live configuration, or game save was accessed.

Harness and captured output:

- Harness: `.scratch/native-udp/native-verification/compiled/probe.js`
- Log: `.scratch/native-udp/native-verification/windows-bare-pass.log`
- Windows artifact: `C:\kb\native-udp-verify-20260909-c4ca3eb`
- Packaging used `bare-pack --host win32-x64 --offload-addons`

The bounded command sequence was:

```sh
node_modules/.bin/tsc -p tsconfig.desktop.json --outDir .scratch/native-udp/native-verification/compiled
node_modules/.bin/bare-pack --host win32-x64 --offload-addons --out /mnt/c/kb/native-udp-verify-20260909-c4ca3eb/probe.bundle .scratch/native-udp/native-verification/compiled/probe.js
/mnt/c/Users/white/AppData/Local/Microsoft/WindowsApps/pwsh.exe -NoProfile -NonInteractive -File C:\kb\native-udp-verify-20260909-c4ca3eb\run.ps1
```

The native log records `UDP_ROUNDTRIP_OK` for application payload sizes
`0, 32, 989, 1000, 1198, 1200`, `TCP_COEXISTENCE_OK outerCount=1`, and
`NATIVE_BARE_WINDOWS_PASS`. This verifies native Bare socket semantics,
bidirectional byte preservation, the bounded fragment path at the source-derived
1198/1200-byte sizes, and UDP/TCP coexistence on one authenticated outer
connection.

## Payload boundary

Installed SecretStream unordered messages add 24 bytes: an 8-byte transmitted
nonce counter and a 16-byte secretbox MAC. libudx's baseline 1200-byte MTU is a
complete packet budget. Its documented header arithmetic accounts for 20-byte
IPv4 or 40-byte IPv6 headers, 8-byte UDP, and 20-byte UDX overhead.

Kepos adds a 23-byte fixed envelope header and permits service IDs up to 64
bytes. The worst-case baseline arithmetic is therefore:

```text
IPv4: 1200 - 48 - 24 - 23 - 64 = 1041 bytes
IPv6: 1200 - 68 - 24 - 23 - 64 = 1021 bytes
```

The implementation uses a 1,200-byte application-datagram cap and limits each
carrier envelope payload to 1,000 bytes. Datagrams from 1,001 through 1,200
bytes use at most two bounded fragments and are reassembled without
retransmission; incomplete reassembly is dropped. UDX may probe a larger route
MTU, but the effective value depends on route, address family, link MTU, and
direct/relay state. Oversized datagrams are dropped and diagnosed; they are not
sent through the reliable TCP service path.

This arithmetic does not establish a maximum Stardew message size or game
compatibility. Decompiled Stardew/Lidgren sources show a configured MTU of
1200 and a compression threshold of 1024, but that threshold is not a maximum,
and Stardew's reliable-ordered application semantics are not equivalent to
Kepos's unordered message path.

Primary references:

- [libudx header constants](https://github.com/holepunchto/libudx/blob/main/include/udx.h)
- [libudx payload calculation](https://github.com/holepunchto/libudx/blob/main/src/udx.c)
- [UDX native API](https://github.com/holepunchto/udx-native)
- [SecretStream implementation](https://github.com/holepunchto/hyperswarm-secret-stream/blob/main/index.js)
- [Stardew multiplayer troubleshooting](https://www.stardewvalley.net/multiplayer-troubleshooting-guide/)
- [Stardew decompiled networking](https://github.com/Dannode36/StardewValleyDecompiled)
- [Lidgren MTU configuration](https://github.com/lidgren/lidgren-network-gen3/blob/master/Lidgren.Network/NetPeerConfiguration.cs)

## Explicitly deferred game acceptance

The native probe does not prove Stardew handshake or serialization compatibility,
real join, world synchronization, or bidirectional gameplay. The user explicitly
deferred real Stardew join/play for this round, so those checks are not merge
gates and no game assets or saves were needed. It also does not establish UI
behavior, WAN or hole-punch behavior, macOS execution, or a shipped GUI build.

A future game acceptance run needs a reachable Windows desktop with the relevant
Stardew build, isolated game state, publisher and subscriber disposable
identities, and a captured direct-IP session alongside the exact network path
and observed datagram sizes.
