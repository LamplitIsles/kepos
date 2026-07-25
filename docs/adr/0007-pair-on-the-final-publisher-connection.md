# ADR 0007: Pair on the final publisher connection

Status: Accepted

Date: 2026-07-25

## Context

Kepos identities already authenticate both sides, but first setup required users
to copy two 64-character public keys and restart a publisher after editing its
allowlist. A temporary pairing endpoint would avoid admitting unknown peers to
the stable publisher key, but it would also require a second DHT lookup, NAT
traversal, Noise handshake, and outer connection after approval.

## Decision

The desktop publisher creates one two-minute `kepos://pair` invitation. It
contains protocol version 1, the publisher public key, its bounded display name,
a random 32-byte bearer token, and the authoritative expiry. The desktop turns
the URI into an SVG QR and then discards the URI. The publisher retains only the
token digest, expiry, and lifecycle state in memory; restart, cancellation, or
expiry invalidates the invitation.

Android scans the QR and connects with its existing installation identity to
the invited publisher key. An unknown authenticated peer admitted during an
active invitation can open only `kepos/pair/1`. It cannot open control, Home, or
any published TCP service and does not count as an active subscriber. At most
three unknown candidates are admitted. Once the pairing channel opens, its
first bounded request must arrive within five seconds.

The first valid token request reserves the invitation and shows the untrusted
device label, platform hint, and authenticated subscriber-key fingerprint in
desktop. Deny closes the candidate. Allow runs one publisher-owned operation in
this order:

1. atomically persist the subscriber public key;
2. add it to the live allowlist;
3. promote the same outer connection and install normal Protomux protocols;
4. send the approval response.

The running publisher waits for an in-flight persistence operation during
shutdown. A persistence failure leaves the candidate unauthorized and pending
so the user may retry or deny it. Existing allowlisted subscribers continue to
work while pairing mode is open.

Subscriber state stores the invited publisher as `publisher.pending.json`
before connecting, but never stores the token. Approval atomically renames that
contact to the active publisher contact. If persistence succeeds and the
approval response is lost, a restart or reconnect uses the pending key for a
normal authorized control handshake and completes the rename. If pairing
expires, Android returns to setup so a new QR can be scanned while retaining the
pending key for this lost-response recovery case.

Invitation, request, and response decoders reject unknown fields and enforce
byte limits. Token comparison is constant-time. Observations contain lifecycle
events and truncated public-key fingerprints; fields named as tokens, secrets,
or seeds are removed. Pairing tokens and private identity material never enter
logs, snapshots, TOML, or durable subscriber state.

V1 keeps one publisher relationship per subscriber. The interactive flow is a
desktop publisher and Android subscriber. The URI is also the future desktop
deep-link format, but receiving macOS URL-open events requires a native
Bare/AppKit boundary that this ADR does not pretend already exists. Headless CLI
users retain explicit public-key setup.

## Consequences

- Approval enables services without a second outer connection or publisher
  restart.
- The stable publisher endpoint accepts a small amount of unknown encrypted
  handshake work only while the user has an active invitation.
- An invitation screenshot can submit one request before expiry, but it cannot
  grant access without local publisher approval.
- TOML-owned desktop publishers update their fresh config atomically; state-owned
  publishers update their existing state config.
- Closing or replacing an invitation closes its unknown candidates. Expiry also
  closes candidates that connected without submitting a request while leaving
  the QR visibly expired until the user generates another.
- Multi-publisher subscribers, desktop deep-link receipt, live revocation,
  device roles, and per-service grants remain separate work.
