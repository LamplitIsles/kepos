# Android subscriber

The Android app is a subscriber-only arm64 client for Android 12 and newer. A
Kotlin foreground service owns one persistent Bare Worklet. That Worklet runs
the same HyperDHT and Protomux subscriber core as the CLI.

The app does not install a VPN, TUN interface, or system DNS service. It binds
local gateway ports inside the app process.

## User flow

On first setup, open **Add device** on a running desktop publisher and scan its
QR code. Desktop shows the authenticated subscriber-key fingerprint before
Allow or Deny. Approval promotes the existing connection; no publisher restart
or second NAT traversal is needed.

A headless CLI, Nix, or container publisher cannot approve that QR
interactively. Use the manual key flow instead:

1. On Android setup, copy **This phone's subscriber key**.
2. Add that public key to the publisher allowlist. If editing TOML for a running
   headless publisher, restart it so the new policy takes effect.
3. Copy the publisher public key printed by `publisher run`.
4. On Android, enter it under **Or enter publisher public key** and choose
   **Connect**.

Only public keys cross between devices. Each device keeps the secret identity
it generated locally.

The service home reads the publisher's real registry and shows its display name
and allowed services. BookOrbit and Mihomo Dashboard open through their
`*.localhost` URLs, Navidrome copies its URL for Navic, and other registry
services without a built-in action use the same HTTP fallback. Mihomo copies
its local SOCKS5 URL. During reconnect, the last known list remains visible but
disabled.

The canonical Navidrome address is:

```text
http://navidrome.localhost:17480/
```

The fixed raw listener at `127.0.0.1:17890` maps to publisher service `mihomo`.
Mihomo's mixed port accepts HTTP proxy and SOCKS5 TCP clients, so Telegram can
use server `127.0.0.1`, port `17890`, with blank credentials while Kepos is
running. Kepos does not carry Mihomo's UDP listener, so SOCKS5 UDP ASSOCIATE is
outside the supported path.

Keep the foreground service running. An explicit Stop remains in effect when
the Activity reopens; Start clears that choice.

## Build and install

Initialize submodules and install root dependencies first. Then build or
install the debug app:

```sh
npm run android:assemble
npm run android:install
```

`android:install` uses `adb install -r`. It installs the app when absent and
updates it while preserving app-private state, including the subscriber
identity. Set `ANDROID_SERIAL` when more than one device is connected. A
signing mismatch fails closed; the command does not uninstall the app or clear
its data.

Local builds read only `[network].bootstrap` from the normal Kepos TOML file
and embed those endpoints in the APK. No publisher policy or private state is
copied. Without an explicit list, the app uses HyperDHT defaults.

## Checks

Run host-side Android tests and lint:

```sh
npm run android:check
```

Run the physical-device lifecycle gate separately:

```sh
npm run android:device-check
```

The gate uses the isolated `io.github.ttalab.kepos.devicetest` package and
ports 18480 and 18490. Android Gradle Plugin cleanup may remove that package,
but it cannot replace or remove the installed `io.github.ttalab.kepos` app.

## Release boundary

```sh
npm run android:release
```

This builds a debug variant and an optimized release variant, enables R8 and
resource shrinking for release, and reports their sizes. The release APK is
unsigned. A `v*` tag currently stores it as a 14-day Actions artifact; it is not
an installable or Play Store release.

Only `arm64-v8a` is packaged. Signing, durable release assets, other ABIs, store
policy, and the remaining foreground-service battery gate are distribution
work.

Physical results and known gaps are recorded in
[Android Navic subscriber evidence](../evidence/android-navic-subscriber-spike.md)
and [Android–desktop QR pairing acceptance](../evidence/android-desktop-qr-pairing.md).
