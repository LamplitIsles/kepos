# Android subscriber

For end-user installation, pairing, and troubleshooting, start with the [public Kepos guide](https://kepos.guion.io/docs/). This page keeps Android build and device-test detail.

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
2. Add that public key to the publisher's labeled subscriber-device policy (for
   example, `subscribers = [{ label = "android", public_key = "..." }]`). A
   running headless publisher reconciles valid TOML policy changes without a
   restart.
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

The fixed TCP listener at `127.0.0.1:18789` maps to publisher service
`openclaw`. The fixed SSH listener at `127.0.0.1:2222` maps to publisher
service `ssh`; use `ssh -p 2222 127.0.0.1`. The existing dsh listener remains
at `127.0.0.1:13080`.

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
npm run release:android -- v0.1.0
```

This release-Mac command derives the app version from an exact stable
`vMAJOR.MINOR.PATCH` or beta `vMAJOR.MINOR.PATCH-beta.N` tag, builds the
optimized arm64 variant, zipaligns it,
signs it with the long-lived Kepos JKS, and checks the resulting certificate
fingerprint against the public value in the repository. It writes the final
versioned APK under `dist/release/` and reports its size against the debug APK.

Only `arm64-v8a` is packaged. Kepos does not use Google Play or Play App
Signing; users sideload the signed APK. Optional end-user checks are in the
[public release verification reference](https://kepos.guion.io/docs/verify/).
Maintainers should use the separate [release procedure](../releasing.md).

Physical results and known gaps are recorded in
[Android Navic subscriber evidence](../evidence/android-navic-subscriber-spike.md)
and [Android–desktop QR pairing acceptance](../evidence/android-desktop-qr-pairing.md).
