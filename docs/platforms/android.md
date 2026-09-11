# Android

For end-user installation, pairing, and troubleshooting, start with the
[public Kepos guide](https://kepos.guion.io/docs/). This page keeps Android
build and device-test detail.

The Android app is an arm64 canonical peer runtime for Android 12 and newer.
A Kotlin foreground service owns one persistent Bare Worklet. The Worklet
loads the canonical `peer.json` and `config.toml` from app-private storage,
uses the shared `startPeer` runtime for configured dial/accept relationships,
and keeps the runtime and its local endpoints alive when the Activity closes.
It stops only after an explicit service stop.

The current UI is a status and service console: it shows the canonical peer
identity, connections, service availability, and local binding count. A fresh
install can enter a peer public key, scan a QR invitation, or consume a
`kepos://pair?...` deep link. The host IPC writes the selected relationship
to the app-private canonical configuration and retains the seed in the
app-private identity file. It does not add a general configuration editor,
reverse-service UI, or reverse UDP. Already-built Android binaries remain
useful as legacy wire clients for the one-way old-client interoperability
contract; that compatibility target is not the source contract of a freshly
built app.

## User flow

On a fresh install, tap `Connect with key` and enter the trusted peer's
64-character public key, or tap `Scan invitation` and scan the invitation
shown by the desktop pairing surface. Opening a `kepos://pair?...` link also
queues the same invitation flow. Key entry sends the canonical `configure`
host request; an invitation sends `pair`. The Worklet persists the
canonical `config.toml` under app-private storage and keeps the one
seed-only `peer.json` identity there. It then starts/reconnects the same
canonical peer runtime.

Admission is separate from service authorization. The peer that publishes a
service must add the Android public key to that service's immediate `allow`
list; selecting or approving the peer does not broaden grants. Keep the
foreground service running while using configured local endpoints. Only public
keys and policy cross the host boundary; the Android seed stays app-private.

For a desktop-managed pairing flow, use the desktop's canonical pairing
surface or the CLI's explicit `peer pair` command to add the Android public key
to the canonical peer list, then add that key separately to each intended
service's immediate `allow` list. Approval never broadens service grants.

The app presents the authenticated catalog and keeps its current
`*.localhost` service convention. Canonical presentation metadata supplies
the action and URL/copy value: supported HTTP actions open their unqualified
URL, while supported raw TCP/Unix actions copy their endpoint or command. For
example:

```text
http://navidrome.localhost:17480/
```

The built-in mappings continue to use loopback TCP/HTTP listeners for dsh,
Navidrome, SSH, and other supported services. UDP entries are filtered from
the Android service directory; SOCKS5 UDP ASSOCIATE and game UDP operation are
outside this client boundary. No Android Unix-socket or reverse-service
configuration UI is implied by the catalog.

## Canonical configuration boundary

Repository-owned bootstrap generation reads only `[network].bootstrap` from
the canonical peer configuration. The Android Worklet receives its
app-private state path, canonical config path, and bootstrap endpoints through
its host protocol; it does not receive another device's private seed or a
copied canonical peer directory.

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

The peer-services implementation validates canonical peer behavior and
old-client → canonical-server interoperability with test-owned identities and
HyperDHT testnets. Those checks are not an Android hardware run and do not
claim reverse-service UI, Android reverse UDP, or a live DSH/cua-driver
session.

Android release packaging remains separate:

```sh
npm run release:android -- v0.1.0
```

The APK is arm64-only, sideloaded, and signed by the existing release process.
Use the [release procedure](../releasing.md) for formal release work.
