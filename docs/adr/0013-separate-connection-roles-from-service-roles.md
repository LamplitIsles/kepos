# ADR 0013: Peer identity and independent connection and service roles

Status: Accepted design following the 2026-09-11 implementation request.
Runtime implementation is pending.

Date: 2026-09-11

A Mac can establish a Kepos connection to a NUC even when the NUC cannot
establish the opposite connection. Allowing the NUC to consume the Mac's
cua-driver over that existing connection requires service provision and
consumption to be independent of connection establishment. Model peers,
published services, and local service bindings separately; reverse access is
an additional authorized channel on an existing connection.

## Agreed constraints

- Cut over configuration to the new schema without old-field aliases,
  fallback parsing, or an automatic migration layer. Deployment tooling and
  policy generators must switch with the runtime that reads their output.
- Service providers own sources and service access policy. Service consumers
  own local bindings. Connection admission alone does not grant reverse
  access, and a remote peer cannot select a local listening path or port.
- Retain old-client-to-new-server interoperability for existing wire
  operations. New-client-to-old-server interoperability is explicitly out of
  scope. Configuration hard cutover is independent of wire compatibility;
  reverse service access requires new capability support at both ends.
- Keep existing unqualified HTTP gateway names such as `dsh.localhost`.
  Do not add automatic peer-qualified URLs in this change. Explicit binding
  configuration resolves a real name conflict; do not introduce a second
  hostname scheme in anticipation of one.

## Identity model

Use one persistent peer identity for both dialing and accepting. The operator
selects an existing active identity rather than generating a new one: the NUC
keeps its current publisher public key, and the Mac keeps its currently used
subscriber public key. With those choices, the current Mac-to-NUC relationship
keeps the same authenticated public keys. Role names do not remain key types
in the new runtime.

Current publisher state stores a seed; current subscriber state stores a
validated public/secret keypair. Both use HyperDHT keypairs, and the subscriber
parser already validates derivation from the seed portion of the secret key.
An operator-run conversion can produce one canonical seed-based peer identity
without changing the selected public key. Do not inspect or print live private
material during design or tests. Verify conversion with test-owned identities;
verify only the resulting public identity during deployment.

For a device where both old identities are used, selecting one requires
updating references to the other in peer pins and ACLs. There is no automatic
equivalence between them and no promise to preserve clients pinned to the
retired identity. Keep rollback backups outside active runtime state; the
new runtime reads one identity format without probing old identity locations.
This is a one-time deployment step, not a permanent migration layer.

This decision replaces the earlier proposal to keep pub=accept and
sub=dial as two separate persistent identities. Dial and accept remain
per-connection responsibilities of the same peer identity.

## Current-code consequences

The current mux already carries bidirectional streams but exposes service
channel initiation only through `RunningMuxSubscriber.open`. The publisher
runtime already tracks the current connection by authenticated subscriber
key. Extending these capabilities still requires role-independent service
resolution, authorization, connection-generation ownership, and cleanup.

The existing TCP, pairing, control, UDP, and Home-registry contracts should
retain their old meanings for old clients. Negotiate reverse support
separately; do not send a new reverse request to a client that has not declared
support or turn unsupported reverse access into a second outbound dial.
The current control protocol already has a legacy-peer path, but that is
evidence of an extension pattern, not proof of compatibility for this change.
Verify old-client-to-new-server operation with frozen wire fixtures or old
built clients. Keep legacy wire field names where those clients require them;
this does not require old configuration fields or old internal role ownership.

ADR 0012 currently specifies outbound upstream connections authenticated with
the republishing publisher key. A unified peer identity removes the need for
an exception to sub=dial: when a republisher retains its old publisher key as
its peer identity, upstreams continue to see that key even when it dials.
Republishers must still select and preserve the intended identity at cutover.

The existing subscriber state also stores its pinned publisher contact. If
the new peer configuration owns contacts, do not leave two writable sources
of truth: perform identity-format and contact-policy transitions as an
operator-run cutover. The new runtime must not fall back to the old
contact policy when new configuration is absent or invalid.

## Working scope

The first new reverse-access slice targets Mac/Linux byte streams, with
loopback TCP and Unix sockets as local endpoints, and cua-driver as the
end-to-end acceptance application. Preserve existing forward HTTP/TCP/UDP
behaviour; reverse UDP and additional platform interfaces are not assumed
implemented by this slice.

Bindings stay configured when a peer is offline and report unavailable.
Connection loss terminates old channels; new requests can use a replacement
connection after capability and authorization checks. Do not replay bytes or
application operations from an old channel. Policy revocation closes affected
channels, and socket cleanup removes only endpoints owned by that runtime.

Service republication remains explicit and applies independent authorization
at each relationship. Importing a service through a binding does not put it
in the local published catalog.

Republication means consuming one peer's service and providing a named service
to another, not necessarily dialing upstream and accepting downstream. For
example, Mac and phone can both dial NUC; NUC can consume Mac's service over a
reverse channel and republish it to phone over phone's existing connection.
NUC accepts both connections and uses one identity throughout. The source
remains a peer-and-service reference, independent of how that peer connected.

The first implementation uses explicit dial/accept configuration per peer
relationship. It does not introduce automatic direction selection or require
both endpoints to initiate connections. Conflicting unqualified gateway names
must not silently select an arbitrary peer or change destination on reconnect;
report the collision and require an explicit local binding.

## Delivery

The implementation request accepts the single-peer-identity direction after
the republication discussion. The previous upstream-ACL question is no longer
a separate role-policy choice: ACL changes follow only where the operator
selects a different surviving key. The user has resolved the URL and
legacy-client-scope questions above.

Deliver configuration/runtime/client integration and operator documentation
in one PR. Real identity conversion, deployment and live Mac GUI verification
are separate operator steps; the implementation run does not perform them.

This decision changes the role vocabulary of ADR 0006 and the identity usage
and terminology of ADR 0012. Their historical decisions remain recorded;
mark the relevant parts superseded as the runtime implementation is completed.
