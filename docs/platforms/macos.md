# macOS desktop

For end-user installation and pairing, start with the [public Kepos guide](https://kepos.guion.io/docs/). This page keeps the macOS operator and contributor details.

The native Apple Silicon app runs the real publisher, subscriber, or both roles
inside one Bare process. Enabled roles share one device-owned HyperDHT node and
one preferred DHT candidate listener while retaining separate role identities
and state. HyperDHT still uses an ephemeral DHT client socket and ephemeral UDX
connection sockets. Kepos starts no Node or Electron child process.

The window groups each connection as a publisher relationship. A remote
relationship shows the publisher this Mac trusts and this Mac's subscriber
identity. A hosted relationship shows this Mac's publisher identity and its
currently connected subscribers. Every displayed fingerprint has a copy action
for the complete public key; private identity material never enters the UI
snapshot.

The shared Kepos TOML decides which roles start. Their identities stay under
`$XDG_STATE_HOME` when it is set:

```text
$XDG_STATE_HOME/kepos-neo/publisher
$XDG_STATE_HOME/kepos-neo/subscriber
```

Without `XDG_STATE_HOME`, the paths fall back to
`~/.local/state/kepos-neo/{publisher,subscriber}`.

Desktop and CLI cannot own the same role state at the same time. Only one
desktop instance may run on a Mac.

## Build and install

An initialized recursive checkout and Xcode command-line tools are required:

```sh
npm run desktop:install
```

This replaces `~/Applications/Kepos.app` and launches it. Run without
installing:

```sh
npm run desktop:run
```

The build compiles the pinned Bare AppKit and WebKit forks, packages
`dist/desktop/Kepos.app`, and links the required native frameworks.

Run the portable desktop checks and native lifecycle gate with:

```sh
npm run desktop:check
npm run desktop:native-check
```

## Roles and configuration

An absent role table, or one with `enabled = false`, is not auto-started by the
desktop. Explicit CLI run commands still start the requested role.

```toml
[network]
bootstrap = ["bootstrap.example:49737"]

[publisher]
enabled = true
display_name = "kosmos"
allow = []
services = []

[subscriber]
enabled = true
gateway_port = 17480
route = "auto"

[[subscriber.services]]
id = "ssh"
local_port = 2222
```

Use `--config <path>` for an isolated configuration. Role-explicit state flags
remain available for smoke tests. Bootstrap is device-wide. A publisher policy
or subscriber binding change restarts only that role and preserves the shared
node; a bootstrap change replaces the node and restarts every enabled role.
One role's startup failure remains visible without stopping a healthy sibling.

## Native surface

The tray is the lifecycle and status surface. The app shows remote services
from the subscriber registry and a separate **Services published here** section
for the local publisher.

- HTTP actions open the macOS default browser.
- Navidrome copies its canonical `*.localhost` URL for Navic.
- SSH copies a loopback command.
- Dagger copies an environment variable that points the CLI at the remote
  engine.
- **Add device** creates a two-minute QR and shows the authenticated candidate
  fingerprint before approval.

Allow writes the configured TOML allowlist atomically, updates the live
publisher, and promotes the same peer connection. Unknown candidates cannot
read the registry or open services.

The release ZIP is an ad-hoc-signed Apple Silicon build and is not notarized.
Developer ID signing, a Mac App Store package, an updater, and pre-login service
operation are not claimed. Windows is a separately supported desktop target;
see [Windows desktop](windows.md) for its packaging and prerequisite boundary.

Lifecycle and pairing decisions are documented in
[ADR 0004](../adr/0004-two-level-subscriber-runtime-locking.md),
[ADR 0006](../adr/0006-desktop-dual-role-runtime-ownership.md),
[ADR 0007](../adr/0007-pair-on-the-final-publisher-connection.md), and
[ADR 0008](../adr/0008-share-one-hyperdht-node-per-device-runtime.md).
