# Android–desktop QR pairing acceptance

Date: 2026-07-25

## Scope

This acceptance run used the debug Android app on a Pixel 7a and the locally
built macOS desktop app. The desktop ran an isolated publisher with one mock
HTTP service. No production publisher state, private key, invitation token,
or public endpoint is recorded here.

## Result

The same-network happy path passed end to end:

1. The desktop publisher generated a two-minute QR invitation.
2. Android scanned it and opened the normal authenticated publisher outer.
3. Before approval, Android showed `Waiting for approval`; no service was
   available.
4. The desktop showed the pending Android device and authenticated key
   fingerprint.
5. `Allow` atomically appended the subscriber public key to the desktop TOML
   allowlist.
6. The existing pairing outer was promoted without another scan or publisher
   restart.
7. Android immediately showed the one published HTTP service as connected.
8. A request through Android's local hostname gateway reached the mock HTTP
   service over the approved Kepos channel.
9. Android process restart restored the approved relationship without a QR.
10. Desktop publisher restart reloaded the TOML allowlist and Android returned
    to connected without a QR.

The temporary HTTP server used a dedicated directory containing only a static
acceptance page. It was bound to loopback and was not a public endpoint.

## Failure-path evidence

Deterministic tests cover invitation expiry and explicit refresh, deny,
invalid and replayed tokens, the five-second first-message deadline,
persistence failure, a lost approval response, and publisher restart recovery.
The physical run also exposed and fixed three Bare compatibility gaps:

- browser globals `TextEncoder` and `TextDecoder` were replaced with `b4a`;
- invitation parsing no longer calls the browser-only
  `URLSearchParams.keys()` method;
- explicit desktop config reads no longer evaluate Node's global `process`.

Regression tests remove the missing globals or methods before exercising the
same code paths.

## Remaining physical matrix

Pairing while Android and the desktop publisher are on different networks was
not rerun in this session. The protocol and HyperDHT testnet paths are covered
automatically, but a cellular-to-Wi-Fi QR acceptance run remains useful field
evidence for NAT traversal latency and the two-minute invitation window.
