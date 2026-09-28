# Making a remote service look local

Kepos is a service-scoped, end-to-end encrypted peer proxy. One runtime owns
one persistent peer identity; its connections may be dialed or accepted
independently of which services it provides or consumes. A named service is
exposed through a local HTTP gateway or TCP port binding.

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

See [DeepSeek Harness integration](../integrations/deepseek-harness.md) for
the complete configuration, pairing, and later live-smoke procedure.
