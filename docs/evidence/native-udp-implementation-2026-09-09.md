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

## Uncompleted game/native gates

The repository's required Windows ad-hoc probe was attempted through
`scripts/windows/nuc-powershell.sh` with a temporary PowerShell operation. It
could not reach the NUC because SSH DNS lookup failed:

```text
ssh: Could not resolve hostname nuc
```

Consequently, no real Stardew join, world synchronization, or bidirectional
gameplay result is recorded. No installed application, live game save, or user
configuration was changed. A future acceptance run needs a reachable Windows
desktop with the relevant Stardew build, isolated game state, publisher and
subscriber disposable identities, and a captured direct-IP session alongside
the exact network path and observed datagram sizes.
