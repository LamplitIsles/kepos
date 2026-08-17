# Making a remote service look local

I wrote Kepos as a general-purpose P2P tunnel. The publisher shares a TCP
service, and the subscriber receives it as a `*.localhost` hostname or an
explicit local port. Browsers, SSH clients, and CLIs all behave as if the
service were on the same machine.

The first things I wanted to reach were ordinary self-hosted services: music
and SSH, without opening public ports or putting every device on a virtual
network. Kepos uses HyperDHT and UDX for the peer connection. Peer keys
authenticate an end-to-end encrypted outer connection, and Protomux carries
the registry, heartbeat, pairing, and one channel per service over that single
connection.

The tunnel ends TCP locally at both peers. Open, data, half-close, reset, and
backpressure cross the multiplexed channel instead of forwarding TCP packets.
That detail matters less to the application than the result: it sees a normal
loopback connection.

## Then dsh showed up

DeepSeek Harness (dsh) is a local-first coding agent with a web interface. Its
configuration panel deliberately trusts loopback same-origin requests as a
defense against DNS rebinding. That is a sensible boundary, but it makes remote
access awkward. A LAN address can receive a `403`; an ordinary tunnel hostname
can leave settings unavailable or non-persistent; and `--trusted-host` means
maintaining another list of addresses as networks change.

SSH forwarding works. I have used it. But then every client owns a tunnel that
has to stay alive. A reverse proxy usually means adding an authentication layer
the application did not ask for.

It turned out that Kepos already had the useful property. On the subscriber,
dsh can be mounted on an explicit loopback listener:

```toml
[subscriber]
enabled = true
gateway_port = 17480

[[subscriber.services]]
id = "dsh"
local_port = 13080
```

Opening `http://127.0.0.1:13080/` gives dsh the loopback `Host` semantics it
expects. There are no `--trusted-host` changes, and its settings continue to
edit and persist across reloads. Android includes this `dsh` mapping by
default, so the service card opens the same loopback URL after the phone pairs
with a publisher that advertises `id = "dsh"`.

Nothing in the transport is specific to dsh. SSH, Dagger, and other raw TCP
services use their own listeners over the same authenticated outer connection;
HTTP services can share the `*.localhost` gateway.

Unknown devices still cannot open the service. Publisher and per-service
allowlists decide which subscriber public keys are authorized. Kepos does not
weaken dsh's browser fence or expose its port publicly. It makes the remote
service look local while keeping access at the service boundary.

Kepos is still a developer preview. Android is sideload-only, the macOS build
is ad-hoc signed and not notarized, and the tunnel does not carry UDP. The dsh
case is useful because it exposes the design in a concrete way: sometimes
"local" is not just a convenient address. It is part of the application's
security model.

See [DeepSeek Harness integration](../integrations/deepseek-harness.md) for the
publisher policy, setup steps, and security notes.
