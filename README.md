# Kepos

Kepos provides an experimental Linux peer VPN for IPv4 TCP connections between explicitly trusted devices. It uses persistent device keys, HyperDHT and Noise, and a Linux TUN interface. Incoming TCP connections are denied unless a peer is granted access.

Install Node 24 and the project dependencies, then build the Linux TUN helper:

```sh
npm ci
npm run vpn:build
npm run kepos -- setup peer --state /path/to/peer --config /path/to/config.toml
```

Exchange public keys securely, configure each peer's address and inbound TCP grants, and start `peer vpn`. See the [Linux VPN guide](docs/peer-vpn.md) for a complete configuration, prerequisites, security boundaries, and limitations. The [CLI reference](docs/cli.md) describes identity and peer admission commands.

The current implementation does not provide application UDP, DNS management, subnet routing, or platform VPN clients outside Linux. A peer key identifies a device; applications remain responsible for their own user authentication.

For development, `npm run typecheck` and `npm test` check the TypeScript code and tests; `npm run vpn:build` builds the native helper. The website is an npm workspace with its own `web:*` commands.
