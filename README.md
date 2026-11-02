# Kepos

Kepos provides an experimental Linux peer VPN for IPv4 TCP connections between explicitly trusted devices. It uses persistent device keys, HyperDHT and Noise, and a Linux TUN interface. Incoming TCP connections are denied unless a peer is granted access.

Install Node `>=24.22 <25` and the project dependencies, then build the Linux TUN helper:

```sh
npm ci
npm run vpn:build
npm run kepos -- setup peer --state /path/to/peer --config /path/to/config.toml
```

Run a managed Linux receiver and privately share a one-use invitation to pair a Linux or macOS device, or explicitly configure peers with `peer vpn`. On Linux, `peer join` reads the invitation at a hidden terminal prompt and saves the resulting configuration; `peer vpn` connects in the foreground. See the [VPN guide](docs/peer-vpn.md) for configuration, prerequisites, security boundaries, and limitations. The [CLI reference](docs/cli.md) describes identity and peer admission commands.

The current implementation does not provide application UDP, DNS management, subnet routing, or mobile VPN clients. The macOS client is experimental and its managed pairing path has not yet been verified on a real Mac. A peer key identifies a device; applications remain responsible for their own user authentication.

For development, `npm run typecheck` and `npm test` check the TypeScript code and tests; `npm run vpn:build` builds the native helper. The website is an npm workspace with its own `web:*` commands.

The website uses the beta Cloudflare CLI and Vite plugin. `npm run web:verify` builds and checks it; `npm run web:deploy:dry-run` builds and validates the Cloudflare deployment without uploading. After a website change is merged and checks pass, `npm run web:deploy` verifies and deploys it with an authorized Cloudflare session. Cloudflare Git Builds are disabled. The Vite client build supplies the static assets, including `_headers` and `_redirects`; deployment settings live in `apps/web/cloudflare.config.ts`.
