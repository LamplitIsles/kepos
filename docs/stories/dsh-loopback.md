# Making a remote service look local

Kepos is a service-scoped, end-to-end encrypted peer proxy. One runtime owns
one persistent peer identity; its connections may be dialed or accepted
independently of which services it provides or consumes. A named service is
exposed through a local HTTP gateway, TCP port, or Unix socket binding.

The tunnel terminates local TCP at each hop. Protomux carries open/data/
half-close/reset and backpressure state over the authenticated outer
connection. The service application receives an ordinary local byte stream.

## Why dsh cares about locality

DeepSeek Harness (dsh) is local-first and deliberately trusts loopback origins
to reduce DNS-rebinding risk. A remote tunnel hostname or LAN address can
therefore fail its browser-trust check. Kepos can make the service local to the
consumer without changing dsh or adding a generic reverse proxy.

For dsh's raw HTTP/TCP port:

```toml
[[services]]
id = "dsh"
name = "DeepSeek Harness"
source = { local_port = 3080 }
allow = ["<consumer-peer-public-key>"]

[[bindings]]
peer = "nuc"
service = "dsh"
listen = { local_port = 13080 }
```

Open `http://127.0.0.1:13080/`; the dsh target receives loopback connection
semantics and no `--trusted-host` update is needed. The existing gateway form
is also `http://dsh.localhost:17480/`.

## CUA over an existing connection

The motivating topology is different from a normal local dsh service. The
Mac-side CUA driver owns a Unix socket, Mac is configured to `dial` NUC, and
NUC is configured to `accept` Mac. NUC then binds Mac's `cua` service locally:

```toml
[[services]]
id = "cua"
name = "CUA driver"
source = { unix_socket = "/run/user/1000/cua-driver.sock" }
allow = ["<nuc-peer-public-key>"]

[[bindings]]
peer = "mac"
service = "cua"
listen = { unix_socket = "/run/user/1000/kepos-cua.sock" }
```

Once the one authenticated outer is established, the NUC-side open travels
over it. There is no second connection from NUC to Mac and no shared
filesystem. NDJSON and inline screenshot bytes are opaque application bytes;
Kepos does not create a CUA-specific protocol adapter.

If a third peer needs the service, NUC must explicitly republish it under a
new service ID with a new immediate-peer allowlist. A local binding alone does
not publish or delegate Mac's identity.

See [DeepSeek Harness integration](../integrations/deepseek-harness.md) for
the complete configuration, pairing, and later live-smoke procedure. The
automated Unix/testnet proof is not a live DSH, CUA-driver, or GUI test.
