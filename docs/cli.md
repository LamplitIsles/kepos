# CLI reference

Run the CLI with `npm run kepos -- <command>`. Use `--state` and `--config` to choose explicit locations; otherwise the CLI uses the user's XDG state and config directories. Keep the seed in `peer.json` private and exchange public keys over a trusted channel.

- `setup peer [--state PATH] [--config PATH]` creates or reuses a seed-only identity and creates an empty configuration if none exists.
- `peer key [--state PATH]` prints the identity's public key.
- `peer status [--state PATH] [--config PATH]` prints the key and configured peer count. This is configuration status, not a probe of a running process.
- `peer pair --label LABEL --public-key HEX [--connection dial|accept] [--config PATH]` explicitly adds a trusted peer or changes its direction when both label and key match. Conflicting labels or keys are rejected. The default direction is `accept`. Configure that peer's VPN address and inbound grants separately in TOML.
- `peer vpn --tun-helper PATH [--state PATH] [--config PATH]` starts the Linux VPN and reloads changed configuration by restarting it.

The strict TOML configuration accepts `peers`, `[network]` and `[vpn]`; old service, binding, gateway and metrics fields are rejected. See [Linux peer VPN](peer-vpn.md) for a complete example, security policy and operational requirements.
