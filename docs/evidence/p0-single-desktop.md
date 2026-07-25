# P0 single-desktop Hypertele evidence

> This run used one physical desktop. It is evidence for the P0 process,
> allowlist, restart, and Home path only. It is not evidence for separate
> devices, NAT traversal, CGNAT, mobile networks, or restricted-network
> quality, relay behavior, or production readiness.

## Environment

- Run: 2026-07-10 12:34:01Z–12:37:53Z
- Host: Apple silicon (`arm64`), macOS 26.5 (build 25F71)
- Node.js: 22.23.1
- Bun: 1.3.10
- Hypertele: 1.1.4
- Network mode: Hypertele public default DHT; publisher and both clients ran on
  the same desktop
- Public Home key:
  `12958a70e83f300e4a0db71c66fc6503de2ed1fa5497b55fff645646f75a1b4d`

Generated state remained under ignored `tmp/p0/`. The publisher config stayed
mode `0600`. No seed or client secret was printed or copied into this record.

## Observed sequence

| Time (UTC) | Observation | Result |
| --- | --- | --- |
| 12:34:01 | Re-ran `bun run p0:setup` | Existing publisher and A/B identities were validated and preserved. |
| 12:34–12:36 | Started publisher with A-only allowlist | Publisher target port `62400`; emitted the expected public Home key. |
| 12:35–12:36 | Started client A | Local port `62482`; Home health returned `ok`; Registry returned the expected Home key. |
| 12:35–12:36 | Started client B before authorization | Local listener became ready on port `62567`, but a three-second health request timed out with curl exit `28`, HTTP code `000`, and zero response bytes. |
| 12:36:41 | Added B's public key to the on-disk allowlist without restarting publisher | B still timed out after three seconds with exit `28`, HTTP code `000`, and zero response bytes. This confirms no trust hot reload. |
| 12:36–12:37 | Stopped and restarted publisher without changing its seed | New target port `62705`; emitted the same public Home key. A and B client processes and local ports stayed running. |
| 12:37:39 | Issued A Home, A Registry, B Home, and B Registry requests concurrently | All four returned HTTP 200. Both Home responses contained `Local Publisher`; both registries contained the stable Home key. |
| 12:37:53 | Sent Ctrl-C to A, B, and publisher supervisors | All exited; no tested listener or Hypertele/supervisor process remained. |

Non-secret readiness excerpts:

```text
Hypertele publisher stdout: hypertele: 12958a70e83f300e4a0db71c66fc6503de2ed1fa5497b55fff645646f75a1b4d
Hypertele client stdout: Server ready @127.0.0.1:62482
Hypertele client stdout: Server ready @127.0.0.1:62567
Hypertele publisher stdout: hypertele: 12958a70e83f300e4a0db71c66fc6503de2ed1fa5497b55fff645646f75a1b4d
```

## RSS snapshots

RSS values are point-in-time `ps` readings in KiB, not peak measurements.

| Process | Before restart | After restart and concurrent requests |
| --- | ---: | ---: |
| Publisher supervisor | 56,096 | 55,984 |
| Hypertele server | 50,624 | 50,160 |
| Client A supervisor | 43,264 | 42,816 |
| Hypertele client A | 55,232 | 53,952 |
| Client B supervisor | 43,376 | 42,816 |
| Hypertele client B | 51,344 | 52,768 |

## Conclusion

The single-desktop P0 public-DHT path passed: A was allowed, B was denied,
editing trust did not affect a running publisher, restart preserved the Home
identity, and two distinct allowed client identities opened the same Home and
Registry concurrently. The isolated three-node smoke is the repeatable proof
for deny-all, no hot reload, restart, and two-client concurrency; the focused
config tests provide the malformed fail-closed proof.
