# DeepSeek Harness integration

[DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness)
is a local-first coding-agent harness with a web interface. Its browser-trust
fence restricts the configuration plane to loopback origins to defend against
DNS rebinding. Requests from a LAN address or ordinary tunnel hostname can
therefore receive an API `403` or use non-persistent settings unless that host
is explicitly configured with `--trusted-host`.

This is a deliberate security boundary, not a dsh defect. Kepos preserves that
boundary while making dsh available from another device.

## Why Kepos works

Kepos presents a published service on the subscriber as a loopback endpoint.
With the explicit local listener used below, dsh receives
`Host: 127.0.0.1:13080`, so its existing browser-trust check passes unchanged.
Settings, credentials, and plugin configuration behave as they do when dsh is
opened directly on its host, including persistence across reloads.

Kepos does not modify dsh, add `--trusted-host` entries, or add an application
authentication layer. The publisher and per-service allowlists still determine
which subscriber public keys may open the service.

## Setup

First create and pair a Kepos publisher and subscriber as described in
[CLI, identity, and configuration](../cli.md). On the publisher, add dsh's HTTP
port to the shared TOML policy:

```toml
[publisher]
enabled = true
display_name = "dev"
allow = ["<subscriber-public-key>"]

[[publisher.services]]
id = "dsh"
name = "DeepSeek Harness"
target_port = 3080
```

Restart a running headless publisher after changing its TOML policy. The
subscriber configuration used for dsh is:

```toml
[subscriber]
enabled = true
gateway_port = 17480

[[subscriber.services]]
id = "dsh"
local_port = 13080
```

Open dsh at:

```text
http://127.0.0.1:13080/
```

The explicit listener binds to loopback. `gateway_port` remains enabled for
other published HTTP services that use Kepos's `*.localhost` gateway.

On Android, the subscriber includes this mapping by default. Once the paired
publisher advertises the service with `id = "dsh"`, the app routes it to
`127.0.0.1:13080` and its service card opens that loopback URL. No phone-side
TOML configuration is required.

## Security and behavior

- The `127.0.0.1:13080` listener preserves dsh's loopback Host semantics. A
  Kepos `*.localhost` gateway URL does too; an ordinary hostname does not.
- Unknown devices cannot use the service. Kepos authenticates peers by public
  key and applies the publisher and service allowlists before exposing it.
- Kepos transports the TCP byte stream over its authenticated, encrypted P2P
  connection. The service does not need a public IP or inbound port forward.
- SSH forwarding offers the same loopback semantics, but requires a tunnel and
  lifecycle management on each client. A reverse proxy or `--trusted-host` can
  also work, with their own authentication and host-management tradeoffs.

Kepos is currently a developer preview. Android installation is sideload-only,
macOS ships an ad-hoc-signed local build, and Kepos does not transport UDP.
