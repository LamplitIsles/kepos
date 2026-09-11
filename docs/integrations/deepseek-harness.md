# DeepSeek Harness integration

[DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) is a
local-first coding-agent harness with a web interface. Its browser-trust
boundary expects loopback origins to defend against DNS rebinding. Kepos keeps
that application boundary intact by presenting authorized services on local
TCP/HTTP endpoints.

The canonical peer runtime also supports the CUA-driver topology that
motivated independent connection direction: Mac dials NUC, NUC accepts the
connection, and NUC opens Mac's authorized Unix-socket service through that
existing outer connection. No reverse DHT connection, shared filesystem,
SSH/WebSocket bridge, or application-specific adapter is required.

## DSH's local boundary

For dsh itself, publish its loopback TCP port as a raw `tcp` service when the
target should see ordinary loopback semantics:

```toml
[[services]]
id = "dsh"
name = "DeepSeek Harness"
source = { local_port = 3080 }
allow = ["<client-peer-public-key>"]
```

Bind it on the consuming peer:

```toml
[[bindings]]
peer = "nuc"
service = "dsh"
listen = { local_port = 13080 }
```

Open `http://127.0.0.1:13080/`. dsh sees the local listener's loopback host
semantics and no `--trusted-host` change is needed. The canonical gateway is
also available for HTTP services as `http://dsh.localhost:17480/`.

Use `kind = "http"` only when the target intentionally consumes Kepos's
immediate-peer assertion. For each HTTP/1.1 request, Kepos removes caller
`Authorization` fields and inserts:

```http
Authorization: Kepos <authenticated-immediate-peer-public-key>
```

This is not applied to raw TCP, and it is not a substitute for target-side
authentication. HTTPS, HTTP/2, CONNECT, and non-WebSocket upgrades are outside
the adapter.

## Mac CUA source and NUC binding

On Mac, where the CUA driver owns the Unix socket and Mac must initiate the
network connection:

```toml
[gateway]
port = 17480

[[peers]]
label = "nuc"
public_key = "<nuc-peer-public-key>"
connection = "dial"

[[services]]
id = "cua"
name = "CUA driver"
source = { unix_socket = "/run/user/1000/cua-driver.sock" }
allow = ["<nuc-peer-public-key>"]
```

On NUC, accept Mac and own the local binding:

```toml
[[peers]]
label = "mac"
public_key = "<mac-peer-public-key>"
connection = "accept"

[[bindings]]
peer = "mac"
service = "cua"
listen = { unix_socket = "/run/user/1000/kepos-cua.sock" }
```

The binding is a transparent byte stream. NDJSON requests, including inline
base64 screenshot bytes, cross the same encrypted Protomux service channel;
Kepos does not interpret or rewrite the CUA application protocol. If NUC
needs to share that service onward, add a separate service such as
`mac-cua` with `source = { peer = "mac", service = "cua" }` and its own
downstream `allow` list. The local binding alone never republishes it.

## Pairing and policy

The peer that approves a candidate gets a configured peer admission, not
implicit access to every service. Add the immediate public key to each
intended service's `allow` list. A source or downstream grant can be revoked
independently; affected channels close, bindings remain configured, and new
requests wait for a fresh connection/catalog/ACL check.

Unknown candidates cannot read Home or open services. A legacy Android client
can still pair with a canonical accept side and consume established TCP,
HTTP, and UDP services, but cannot initiate reverse CUA service opens because
it does not advertise the peer-services capability.

## Verification boundary

The repository verifies the transport with temporary Unix/TCP listeners,
representative NDJSON and large payloads, real local HyperDHT testnets, and
old-client wire paths. Those automated checks do not install dsh or the
cua-driver, operate a real Mac desktop, validate a production network path, or
perform a live GUI trial.

After a separately approved deployment, an operator can perform this smoke
check:

1. Confirm the Mac and NUC public keys against the deployment record without
   copying private state into a ticket or log.
2. Start the CUA driver on Mac and verify that its configured Unix socket is
   present and owned by the intended user.
3. Start canonical `peer run` on both sides with Mac `dial` and NUC `accept`.
4. Confirm the NUC binding reports available and connect the DSH/driver client
   to the NUC-local socket.
5. Send one harmless NDJSON request and one representative inline-image
   response; verify exact response bytes and logs contain no secrets.
6. Stop the Mac driver and confirm the binding becomes unavailable, then
   restart it and verify a new request succeeds without replaying the old one.

This procedure is intentionally documented for a later operator run. It was
not performed as part of this implementation, and no live identity or DSH
state was inspected.
