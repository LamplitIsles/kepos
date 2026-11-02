# CLI reference

Run the CLI with `npm run kepos -- <command>`. Use `--state` and `--config` to choose explicit locations; otherwise the CLI uses the user's XDG state and config directories. Keep the seed in `peer.json` private and exchange public keys over a trusted channel.

- `setup peer [--state PATH] [--config PATH]` creates or reuses a seed-only identity and creates an empty configuration if none exists.
- `peer key [--state PATH]` prints the identity's public key.
- `peer status [--state PATH] [--config PATH]` prints the key and configured peer count. This is configuration status, not a probe of a running process.
- `peer pair --label LABEL --public-key HEX [--connection dial|accept] [--config PATH]` explicitly adds a trusted peer or changes its direction when both label and key match. Conflicting labels or keys are rejected. The default direction is `accept`. Configure that peer's VPN address and inbound grants separately in TOML.
- `peer vpn --tun-helper PATH [--state PATH] [--config PATH]` starts the Linux VPN and reloads changed configuration by restarting it.
- `peer receiver --tun-helper PATH --pool CIDR [--state PATH] [--config PATH]` runs the managed receiver. Its config supplies one VPN address and no static peers. The pool is an explicitly chosen unused IPv4 network with a /16 through /30 prefix.
- `peer invite [--state PATH] [--exclude-address IPV4]` asks the running receiver for a ten-minute, single-use bearer invitation. Its output is secret: share it privately and do not copy it to logs. The optional address excludes one currently unassigned usable pool address from this invitation's new allocation; see the recovery procedure in [Peer VPN](peer-vpn.md).
- `peer devices [--state PATH]` lists authorized public keys, assigned addresses, and TCP grants.
- `peer grant --key HEX --ports all|PORT[,PORT...] [--state PATH]` replaces a device's inbound TCP grant with all ports or at most 256 distinct ports. `peer revoke --key HEX [--state PATH]` removes the device. Both interrupt existing receiver sessions before applying the change.

The receiver and its administrative commands must use the same state path and operating-system account. The service owns a private sibling state directory and local control socket while running. Administrative commands do not take over the peer's identity lock; if the service is unavailable they fail instead of editing state behind it. The managed receiver reads its TOML on startup; restart it to change the receiver address, network settings or pool. Persisted state rejects conflicting receiver identity, address or pool rather than silently changing allocations.

The strict TOML configuration accepts `peers`, `[network]` and `[vpn]`; old service, binding, gateway and metrics fields are rejected. See [Linux peer VPN](peer-vpn.md) for a complete example, security policy and operational requirements.
