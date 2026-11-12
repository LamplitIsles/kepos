# Android peer VPN

The Android client is a native Kotlin application with a Compose UI, an Android
`VpnService`, and the official Bare Kit Kotlin binding running the existing
TypeScript peer VPN engine in a worklet. The worklet host creates the IPC and
starts reading before the worklet itself starts, which is the order bare-kit's C
reference and this binding's own JVM and Android device tests use; the worklet
touches `Bare.IPC` as its module loads and may exit early, so creating the host
end only afterwards could fail or miss its output. It joins a managed receiver with an
invitation, keeps a seed-only identity in app-private storage, and carries IPv4
TCP overlay traffic; the receiver operator is described in
[peer-vpn.md](peer-vpn.md).

Only an `arm64-v8a` debug build has been produced and inspected. Nothing in this
document is evidence of end-to-end device execution. The operator reported that
pairing succeeded on a newer build; the installed package was not independently
byte-matched to a recorded artifact, and the system VPN consent dialog,
`VpnService` route behaviour with actual packet flow, worklet startup on
Android, native addon loading, cellular/lock-screen behaviour, always-on VPN and
lockdown mode remain unconfirmed. A build succeeding, or one reported pairing,
is not a network test.

## What the client does

- `prepareIdentity` reads the fixed identity, creating one only when the device
  is unpaired and no runtime holds it.
- `pair` submits one invitation to the receiver and stores the returned
  configuration only after it is durable. An unconfirmed result is reported as
  an unknown outcome; the app never replays the invitation automatically and
  tells the operator to inspect authorized devices first.
- `connect` starts the worklet, applies the returned overlay settings to a TUN
  device and runs until the user disconnects, the system revokes the VPN or the
  worklet fails. The configured peer list arrives with the settings message and
  is published while the attempt is still connecting, so the screen can show
  "receiver not connected" before the first peer status arrives.
- `disconnect` stops through the worklet's own stop message so the engine
  releases the identity before the process releases the lock.

Each pairing or connection attempt carries its own generation between the
controller and the service. A stop request names the attempt it was issued for,
so a late stop for an abandoned attempt cannot close a newer tunnel. A cancelled
or timed-out call asks the service to stop that attempt. If that stop cannot be
dispatched, the attempt stays visible instead of being reported idle, so the
tunnel remains closable through `disconnect()` and its own outcome still reaches
the state.

The invitation is marked as possibly sent before the pair frame can enter the
outbound queue, because the writer consumes that queue concurrently; marking
afterwards could report an already written invitation as unsent. A queue that
refuses the frame proves nothing was sent and reports a local failure, which is
distinct from the unknown outcome of an interrupted attempt.

Each pairing or connection attempt carries its own generation between the
controller and the service. Only the current attempt can publish state, and a
late completion from an abandoned attempt is ignored, so a timeout or a rejected
service start cannot leave the screen in `Pairing`/`Connecting` or overwrite the
next attempt. A connection that is running reports success once; a later
disconnect clears the tunnel state without reporting a failure.

Pairing and connecting are separate operations, as on iOS: pair while
disconnected, connect afterwards. Pairing opens no TUN, so it needs no system
VPN permission; only connecting does. The activity leaving the foreground does
not disconnect the tunnel.

## Build

Prerequisites on this host: Temurin JDK 21 and the Android SDK with
`platforms;android-36` and `build-tools;36.0.0`. `source ~/Android/Sdk/env.sh`
sets `JAVA_HOME`, `ANDROID_HOME` and `PATH`.

```sh
npm run android:bundle   # esbuild + bare-pack + bare-link into generated paths
npm run android:build    # the same, then :app:assembleDebug
npm run android:test     # bundle, then the JVM unit tests
npm run android:verify-apk
```

`scripts/build-android.mjs` writes `android/app/src/main/assets/kepos.bundle`
and `android/app/src/main/jniLibs/arm64-v8a/*.so`; both are generated and
ignored by Git. It also copies `libc++_shared.so` for arm64 from the installed
NDK (`KEPOS_ANDROID_NDK`, or the single NDK under the SDK) after checking that
it is an AArch64 ELF. The `udx-native` and `sodium-native` prebuilds link the
NDK C++ runtime, Android does not provide it to apps, and without it the addon
cannot be loaded at runtime — the failure appears only as
`AddonError: CANNOT_LOAD` followed by a native abort. It fails if the bundle references anything other than the four
locked addons (`bare-inspect 3.1.4`, `bare-type 1.4.0`, `sodium-native 5.1.0`,
`udx-native 1.20.7`) or if another architecture appears. The debug APK is
`android/app/build/outputs/apk/debug/app-debug.apk`.

`scripts/verify-android-apk.py` reads the built artifact only: it checks the
bundle asset, the `arm64-v8a`-only native libraries, the four addons,
`libbare-kit.so`, the VPN service metadata, the APK signature when `apksigner`
is available, and the core-library API level of every `java`/`javax` method the
dex references.

It also resolves the `DT_NEEDED` closure of every packaged native library: each
dependency must be another library in the APK or a public platform library, so
an addon that links the C++ runtime cannot silently ship without it.

The core-API check exists because compiling on a current JDK can resolve a
JDK-only member that the device floor does not have. `java.util.stream.Stream`
is available from API 24, but `Stream.toList` only from API 34, and lint's
`NewApi` check does not cover `java.*`, so a call compiled against JDK 21
against `minSdk` 29 links fine and then throws `NoSuchMethodError` on the
device. The check resolves each dex method reference against the platform's
`data/api-versions.xml` and fails on anything above `minSdk`; the identity
directory listing therefore uses `Files.newDirectoryStream` instead of a
stream.

Versions are pinned in `android/gradle/libs.versions.toml`: Gradle 8.14.6,
Android Gradle Plugin 8.13.2, Kotlin 2.4.21, `compileSdk`/`targetSdk` 36,
`minSdk` 29. AndroidX versions are the newest releases whose AAR metadata still
allows `compileSdk` 36 with AGP 8.13.2; newer Compose, `core` and `lifecycle`
releases declare `minCompileSdk=37` and `minAndroidGradlePluginVersion=9.1.0`.
The Kotlin version must be at least the 2.4.20 that built
`bare-kit-kotlin v0.2.2`, because Kotlin metadata is not readable by older
compilers.

## Identity, configuration and locking

`kepos/peer/peer.json` holds `{"seed": "<64 lowercase hex>"}` in a `0700`
directory with a `0600` file. Reads reject a symlink, another entry in the
directory, other permissions, a size outside 1–4096 bytes, and any shape other
than that single key. Creation happens once: a temporary directory is renamed
into place and an existing identity is never replaced, rewritten or adopted from
elsewhere. `kepos/config.json` holds only the assigned address, the receiver
address and the receiver key; it starts as `{}` and is replaced atomically.

Directory and file writes are flushed and a failed directory fsync is reported
rather than ignored: identity creation then fails without claiming durable
state, and a pairing whose configuration could not be made durable reports an
unknown outcome. This matches the Mac and iPhone clients, which treat a failed
`fsync` as a local state failure. A failed creation never replaces an existing
identity, and a later attempt can still create one.

The seed never leaves the app: the public key is derived locally with the
Bouncy Castle lightweight Ed25519 API, which is the same RFC 8032 expansion
libsodium performs inside the worklet. Two tests pin that: the RFC 8032 test
vector and a fixed seed whose libsodium-derived key is recorded, so a
disagreement fails the build rather than a device. The worklet also reports the
public key it derived from the seed it was given, and the session refuses to
run if the two differ.

Packets from the worklet are accepted as soon as the packet gate is published,
which happens before the ready frame can be written by the concurrent IPC writer;
the engine may already be running and can report a packet immediately after — or
in the same IPC chunk as — its running message. A ready frame the queue refuses
fails the attempt, so the gate never stays open without an engine. A packet before that
point is a protocol violation and fails the attempt. A peer status that arrives
before the running message is applied rather than treated as a bridge failure,
since the engine starts its dial peers without awaiting them. No global JCA provider is installed and no signature is
produced.

`kepos/.peer.peer.runtime.lock` is held for a whole pairing or connection. The
lock is advisory and per-process; the kernel releases it if the process dies.
When a worklet does not exit after the stop message and a terminate request, the
session reports that the identity is still held and the service ends its own
process instead of releasing the lock, because another runtime must never reuse
an identity a live worklet may still own.

The app directory uses `filesDir`, which the system already isolates per app;
the permission and symlink checks above are still enforced on every read.

## TUN, routes and loop protection

`VpnService.Builder` is configured with the assigned address as a `/32`, one
`/32` route per configured peer address, MTU 1400, blocking reads and a session
name. Only the peer `/32` routes enter the tunnel: DNS, IPv6, subnets,
application UDP and exit-node behaviour are otherwise left to the device's
existing network, exactly as on the other platforms. A destination that matches
a configured peer `/32`, including a DNS server or other service reachable at
that address, is carried by the overlay instead.

Loop protection is `addDisallowedApplication` for Kepos's own package, so the
app's own underlay sockets to HyperDHT and UDX never enter this tunnel. The
TypeScript DHT facade exposes no socket descriptor, so per-socket `protect()`
is not available and is not claimed. If `addDisallowedApplication` or
`establish()` fails, the connection fails with a fixed error; it does not
continue without protection.

Android can report routes for visible links through
`ConnectivityManager.getLinkProperties`, and that call needs
`ACCESS_NETWORK_STATE`. This client neither requests that permission nor scans
routes, and even such a snapshot would not establish an existing host route,
route precedence, OEM routing policy or later network changes. What it checks is
narrower: it reads the device's own unicast IPv4 interface addresses through
`NetworkInterface` and fails when the assigned address or a peer address is
already one of them. When those addresses cannot be read at all, pairing fails
before the single-use invitation is sent and a connection fails before the TUN
opens. This is an interface-address check, not a route check, and the overlay
pool still has to avoid the local networks by configuration.

A `/32` route that another link holds for a peer address, and how the platform
ranks it against this tunnel, is not evaluated here in either direction: neither
safe nor unsafe is claimed, and that platform routing behaviour is unverified on
a device in this document.

Always-on VPN and lockdown mode are not supported by this build, and the service
declares the documented opt-out
(`android.net.VpnService.SUPPORTS_ALWAYS_ON=false`; the field defaults to true
when absent). The platform's always-on start path rejects an opted-out package
and clears the setting; whether the system Settings screen hides the option is
not verified here. `addDisallowedApplication` behaviour under lockdown is also
unverified, so do not enable either for a test.

## Foreground service

Pairing runs as a short-lived foreground service with the `dataSync` type
because no VPN configuration exists yet. A connection starts with the same type
and switches to `systemExempted` after `establish()` succeeds, since Android
documents that type as available to VPN apps configured in system settings. If
the system refuses the switch the session keeps the `dataSync` type, and the OS
may then limit a long session; that fallback is deliberately visible here
rather than silent. Device behaviour of this switch is unverified.

The service returns `START_NOT_STICKY`, so an operation the system restarts is
never replayed. `onRevoke` and service destruction stop the session through the
worklet.

## Observed build evidence (2026-11-10, N5)

- `:app:testDebugUnitTest`: 76 JVM tests, 0 failures — 73 backend tests
  (protocol framing and bounds, identity and file permissions, configuration and
  locking including a symlink planted at the lock path, session
  pairing/connection/teardown with fakes, controller pairing/connection/timeout/
  cancellation/stale-attempt handling against a fake service boundary, peer
  publication scoped to its attempt, error mapping, no secrets in stored
  configuration) and the 3 UI presentation tests that arrive with the screen.
  Reverting the cancellation stop, the attempt-scoped peer publication or the
  connecting-phase publication makes the corresponding tests fail.
- `:app:assembleDebug`: `app-debug.apk`, 89 113 983 bytes, SHA-256
  `8dfb64fd7bd119b2cc891ab0a910aa09287d16577851197e1681d3f929587f62`. This is
  the artifact of the commit that contains this document; it is larger than
  earlier builds because it now packages the NDK C++ runtime. Earlier figures —
  79 588 399 bytes / `969140de…`, 79 588 927 bytes / `294576dd…`, 79 587 523
  bytes / `54743f3a…`, 79 587 463 bytes / `9acc987e…` and the UI-only build
  `9db6e367…` — belong to previous revisions and are not the current artifact.
- `aapt2 dump badging`: package `io.lamplitisles.kepos`, versionCode 1,
  minSdkVersion 29, targetSdkVersion 36, native-code `arm64-v8a`; service
  `io.lamplitisles.kepos.vpn.KeposVpnService` with
  `android.permission.BIND_VPN_SERVICE`, exported, foreground service type
  `0x401` (`dataSync|systemExempted`).
- `scripts/verify-android-apk.py`: `assets/kepos.bundle` 731 432 bytes; native
  libraries only under `lib/arm64-v8a` (`libbare-inspect.3.1.4.so`,
  `libbare-type.1.4.0.so`, `libsodium-native.5.1.0.so`, `libudx-native.1.20.7.so`,
  `libbare-kit.so`, `libc++_shared.so`, `libandroidx.graphics.path.so`); the VPN
  service declares `android.net.VpnService.SUPPORTS_ALWAYS_ON=false`; APK Signature Scheme v2 with
  the locally generated Android debug certificate (`CN=Android Debug`).
- The whole verification (clean build, unit tests, APK) peaked at 1 637 244 KiB
  resident (about 1.56 GiB) with `-Xmx768m`, a 512 MiB metaspace cap, in-process
  Kotlin compilation and a 384 MiB test JVM; `~/.gradle` plus the project build
  directory measured 1.7 GiB. A smaller 640 MiB heap with a 256 MiB metaspace cap
  did not complete (the build stalled), so those limits are recorded as too low
  rather than reused.

The APK is signed with the debug key that Gradle generated in the user's
`~/.android` directory on the first build. That key is not a release identity:
updating an installed release build would need its own signing key, and no
release keystore is created or claimed here.
