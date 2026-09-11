# macOS desktop

For end-user installation and troubleshooting, start with the
[public Kepos guide](https://kepos.guion.io/docs/). This page keeps macOS
operator and contributor detail.

The native Apple Silicon app owns one canonical peer runtime inside one Bare
process. That runtime owns one HyperDHT identity/node, the gateway, service
bindings, pairing, config reload, diagnostics, and shutdown. The app does not
start a Node or Electron child process.

The peer UI shows the local public-key fingerprint, configured peer labels and
dial/accept directions, capability/connection state, published services,
bindings, gateway, and pairing phase. It never displays the private seed.

## Paths and first launch

The desktop reads the canonical config and peer state:

```text
$XDG_CONFIG_HOME/kepos/config.toml
$XDG_STATE_HOME/kepos-neo/peer/peer.json
```

Without the XDG overrides, these are `~/.config/kepos/config.toml` and
`~/.local/state/kepos-neo/peer/peer.json`. First launch creates an empty
canonical config and seed-only peer state. It never creates or probes old
publisher/subscriber state. Desktop and CLI use the same canonical peer lock;
only one desktop instance may run.

## Build and install

An initialized recursive checkout and Xcode command-line tools are required:

```sh
npm run desktop:install
```

This replaces `~/Applications/Kepos.app` and launches it. Run without
installing with:

```sh
npm run desktop:run
```

Portable host checks and the native lifecycle gate are:

```sh
npm run desktop:check
npm run desktop:native-check
```

The release ZIP is ad-hoc signed and not notarized. Developer ID signing,
App Store packaging, updater, and pre-login service operation are not claimed.

## Canonical configuration

Use the same TOML as the headless CLI; desktop role flags are removed:

```toml
[network]
bootstrap = ["bootstrap.example:49737"]

[gateway]
port = 17480

[[peers]]
label = "nuc"
public_key = "<nuc-peer-public-key>"
connection = "dial"

[[services]]
id = "cua"
name = "CUA driver"
source = { unix_socket = "/run/user/1000/cua-driver.sock" }
allow = ["<nuc-peer-public-key>"]

[[bindings]]
peer = "nuc"
service = "ssh"
listen = { local_port = 2222 }
```

`peers`, `services`, and `bindings` are required arrays. Service source and
binding endpoint variants are fixed by the strict parser. Empty/missing
service grants deny access. Use [CLI, identity, and configuration](../cli.md)
for the full schema and identity conversion order.

Once a configured peer connects, either side can open an explicitly granted
byte-stream service over that one outer connection. A peer that only supports
the old wire is still able to consume established server-side services; the
desktop reports reverse capability as unsupported instead of dialing a second
connection.

## Pairing and service actions

**Add peer** creates a short-lived invitation. The candidate's authenticated
public-key fingerprint is shown before **Approve** or **Deny**. Approval adds
the key as an `accept` peer and authorizes its current connection; it does not
add the key to a service `allow` list. Operators must grant each service
explicitly. Expiry and denial close the candidate and do not leave a live
binding.

HTTP services retain `http://<service-id>.localhost:17480/`. Raw TCP services
and Unix bindings expose their configured local endpoint. If several peers
offer the same HTTP service ID, the UI/runtime reports an ambiguity and the
operator must configure an explicit binding; it never selects by reconnect
order. UDP service cards copy a loopback endpoint and do not open a browser.

For the DSH use case, the canonical Mac service can publish the cua-driver Unix
socket. A NUC-side binding to that service carries the NDJSON byte stream and
inline image bytes transparently. The automated repository test uses a
temporary Unix socket and HyperDHT testnet; it is not a live CUA driver or GUI
trial.

## Lifecycle and cutover

Closing the main window hides it. **Open Kepos** restores it; **Quit Kepos**
stops pairing candidates, service channels, bindings, gateway, WebView, tray,
and the peer runtime through one idempotent shutdown path. A binding remains
configured and reports offline while its target peer is disconnected. Existing
streams fail on disconnect and are not replayed.

For a later identity-preserving cutover, select Mac's active old subscriber
public key as this peer's identity, back up state outside the active path, stop
the old runtime, run `peer convert` with the required expected public key,
rewrite canonical peer/allow entries, then start only the canonical peer
runtime. This implementation run did not inspect or convert real Mac state.
