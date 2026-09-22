# Windows desktop

For end-user installation and troubleshooting, start with the
[public Kepos guide](https://kepos.guion.io/docs/). This page keeps Windows
packaging and operator detail.

Kepos supports Windows 10 x64 build 19045 (22H2) and later and Windows 11 x64
as a portable desktop application with an optional per-user scripted install.
The ZIP contains the complete x64 Windows App Runtime tree. WebView2 and
Microsoft Visual C++ Redistributable remain system prerequisites.

The ZIP has two paths:

- **Portable:** launch `Kepos\App\Kepos.exe` while keeping the complete tree
  together.
- **Per-user install:** run `Kepos\Install.cmd`; it installs the owned tree
  under `%LOCALAPPDATA%\Programs\Kepos` and creates Start Menu/Desktop
  shortcuts without elevation.

The installer is not MSI, MSIX, a Store package, a Windows service, a login
task, or an updater. The executable and scripts are not Authenticode-signed;
SmartScreen may show a warning. Release ZIP integrity and Minisign/SHA-256
verification remain the release boundary.

## Canonical runtime and paths

The desktop app owns one canonical peer runtime, one peer identity, one DHT
node, gateway, bindings, pairing surface, and shutdown path. It does not
start separate publisher/subscriber daemons or probe their old state.

```text
%APPDATA%\Kepos\config.toml
%LOCALAPPDATA%\Kepos\state\peer\peer.json
```

`peer.json` is seed-only private state. The directory and file are owner-only
where the platform supports those permissions. The canonical config uses
`peers`, `services`, and `bindings`; role-specific tables/flags are removed.

Windows supports local loopback TCP sources/bindings and TCP/HTTP/UDP service
operations. Unix socket sources and bindings are rejected clearly because
Windows has no compatible endpoint in this host surface. A configured binding
does not publish its remote service.

Desktop diagnostics are stored at `%LOCALAPPDATA%\\Kepos\\state\\diagnostics`.
Copy diagnostics from the app to export bounded, redacted normal and critical
connection evidence; the latest owner-only `fatal.json` survives restart. An
uncaught JavaScript exception or unhandled rejection is recorded synchronously
then the desktop exits nonzero. Safe heartbeat and transport counters are
retained without socket addresses, and Home registry timeouts close only their
request tunnel instead of escaping as an unhandled stream error. Native
failures can bypass JavaScript capture and need matching symbols.

Example:

```toml
[gateway]
port = 17480

[[peers]]
label = "nuc"
public_key = "<nuc-peer-public-key>"
connection = "dial"

[[services]]
id = "ssh"
name = "SSH"
source = { local_port = 22 }
allow = ["<nuc-peer-public-key>"]

[[bindings]]
peer = "nuc"
service = "remote-shell"
listen = { local_port = 0 }
```

Use the [CLI configuration reference](../cli.md) for all fields. The gateway
retains `http://<service-id>.localhost:17480/`; a same-name conflict is
reported until an explicit binding identifies the peer.

## Install, repair, and upgrade

Quit Kepos from the notification-area menu before installing, repairing, or
upgrading. The scripts never terminate a running process and refuse when a
`Kepos.exe` process is using the source or installed tree.

```powershell
New-Item -ItemType Directory .\Kepos-vX.Y.Z
Expand-Archive .\kepos-windows-x64.zip -DestinationPath .\Kepos-vX.Y.Z
# portable:
.\Kepos-vX.Y.Z\Kepos\App\Kepos.exe
# or installed:
.\Kepos-vX.Y.Z\Kepos\Install.cmd
```

An upgrade stages and validates the complete owned tree before swapping it.
An unowned, malformed, linked, or running destination is left in place. A
failed replacement preserves the previous owned installation. Uninstall
removes only the owned program tree and shortcuts; it preserves
`%APPDATA%\Kepos`, canonical state, diagnostics, and unrelated user files.

## Firewall and lifecycle

Windows Defender Firewall may ask to allow the app on networks where DHT
connectivity is needed. Kepos does not open a public service port. Allow the
deployment's outbound UDP and HyperDHT candidate listener as appropriate;
the candidate range alone does not guarantee an established UDX path.

Closing the main window hides it. **Open Kepos** restores it and **Quit Kepos**
closes service channels, bindings, gateway, WebView, tray, and the peer runtime
idempotently. Offline bindings remain configured and unavailable. A disconnect
terminates active streams; reconnect performs fresh peer-control and ACL checks
and never replays old bytes.

For a future key-preserving cutover, select the intended existing Windows peer
key, stop the old runtime, back up state outside the active path, use the
explicit offline `peer convert` helper and expected public key, rewrite
canonical grants, and start only `peer run`. This implementation did not
inspect or convert live Windows state.

## Native boundary

Run portable host checks with:

```sh
npm run desktop:check
```

Native Windows artifact and installer checks remain platform-specific. The
repository's automated transport checks use temporary listeners and testnet
identities; they do not claim a live Windows GUI, DSH, or real game session.
ARM64, Authenticode signing, MSI/MSIX, Store delivery, automatic updates,
login startup, and Windows Service operation are not supported by this
release.
