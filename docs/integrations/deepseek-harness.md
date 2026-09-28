# DeepSeek Harness integration

[DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) is a
local-first coding-agent harness with a web interface. Its browser-trust
boundary expects loopback origins to defend against DNS rebinding. Kepos keeps
that application boundary intact by presenting authorized services on local
TCP/HTTP endpoints.

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

## Pairing and policy

The peer that approves a candidate gets a configured peer admission, not
implicit access to every service. Add the immediate public key to each
intended service's `allow` list. A source or downstream grant can be revoked
independently; affected channels close, bindings remain configured, and new
requests wait for a fresh connection/catalog/ACL check.

Unknown candidates cannot read Home or open services. After pairing approval,
the Android peer must establish the canonical `kepos/peer-control/1` contract
before it can use any service.

## Verification boundary

The repository verifies the transport with temporary TCP listeners,
representative large payloads, and real local HyperDHT testnets. Those
automated checks do not install dsh or validate a production network path.

After a separately approved deployment, an operator can perform this smoke
check:

1. Confirm both peer public keys against the deployment record without
   copying private state into a ticket or log.
2. Start dsh and canonical `peer run` on both sides.
3. Confirm the client binding reports available and open dsh through its local
   TCP port.
4. Stop dsh and confirm a new request fails, then restart it and verify a new
   request succeeds without replaying the old one.

This procedure is intentionally documented for a later operator run. It was
not performed as part of this implementation, and no live identity or DSH
state was inspected.
