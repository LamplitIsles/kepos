# Android

For end-user installation, pairing, and troubleshooting, start with the
[public Kepos guide](https://kepos.guion.io/docs/). This page keeps Android
build and device-test detail.

The Android app is an arm64 subscriber client for Android 12 and newer. A
Kotlin foreground service owns one persistent Bare Worklet. The Worklet runs
the shared HyperDHT/Protomux subscriber wire client, keeps its local listeners
alive when the Activity closes, and stops only after an explicit service stop.

Android is intentionally the existing legacy-client interoperability target
for the canonical peer runtime. It can pair with a new accept-side peer,
read the authenticated Home catalog, and consume established TCP/HTTP/UDP
operations. It does not advertise `kepos/peer-services/1`, initiate reverse
service opens, expose a reverse-service UI, or bind UDP services in the app.
No Android Unix-socket interface is added by the peer-services change.

## User flow

Pair with a running desktop peer that exposes the existing pairing wire:

1. Open **Add device** on the desktop and scan its QR code.
2. Confirm the candidate public-key fingerprint on the desktop.
3. Approve the candidate. Approval changes the desktop's configured peer
   admission but does not broaden any service allowlist.
4. Keep the Android foreground service running while using its local service
   listeners.

A headless canonical peer cannot approve a QR interaction. Use the explicit
   public-key workflow instead: copy the Android client public key, add it to
   the canonical peer's `peers` list and to each intended service's immediate
   `allow` list, then let `peer run` reload the config. Only public keys cross
   this boundary; Android secret identity material stays app-private.

The existing app presents the authenticated registry and keeps its current
`*.localhost` service convention. For example:

```text
http://navidrome.localhost:17480/
```

The built-in mappings continue to use loopback TCP/HTTP listeners for dsh,
Navidrome, SSH, and other supported services. UDP entries are filtered from
the Android service directory; SOCKS5 UDP ASSOCIATE and game UDP operation are
outside this client boundary.

## Canonical configuration boundary

Repository-owned bootstrap generation reads only `[network].bootstrap` from
the canonical `peers` configuration. The Android Worklet receives bootstrap
endpoints through its host protocol; it does not receive a publisher policy,
another device's private seed, or a copied canonical peer directory.

The canonical configuration shape is documented in
[CLI, identity, and configuration](../cli.md). Old subscriber wire fields in
the Worklet are compatibility code at the network boundary, not a second
repository-owned TOML source of truth.

## Build and install

Initialize submodules and install root dependencies first:

```sh
npm ci
npm run android:assemble
npm run android:install
```

`android:install` uses `adb install -r`, preserving app-private identity
state. Set `ANDROID_SERIAL` when more than one device is connected. A signing
mismatch fails closed; the command does not uninstall the app or clear data.

## Checks

Run host-side bundle, Worklet, and Android lint checks:

```sh
npm run android:check
```

Run the physical-device lifecycle gate separately:

```sh
npm run android:device-check
```

The device gate uses the isolated `io.github.ttalab.kepos.devicetest` package
and test ports. It cannot replace or remove the installed
`io.github.ttalab.kepos` app.

## Scope and evidence

The peer-services implementation validates old-client → canonical-server
pairing and service behavior with test-owned identities and HyperDHT
testnets. Those checks are not an Android hardware run and do not claim
reverse-service UI, Android UDP, or a live DSH/cua-driver session.

Android release packaging remains separate:

```sh
npm run release:android -- v0.1.0
```

The APK is arm64-only, sideloaded, and signed by the existing release process.
Use the [release procedure](../releasing.md) for formal release work.
