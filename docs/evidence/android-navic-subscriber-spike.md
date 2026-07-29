# Android Navic subscriber spike evidence

Date: 2026-07-22

Device: Pixel 7a (`lynx`), Android 16, arm64-v8a

Bare Kit: 2.3.0

> Superseded product behavior: this dated gate used a Navidrome compatibility
> listener on port 17481 (18481 in `deviceTest`). Current Android builds keep
> Navidrome on the hostname gateway and use port 17890 (18490 in `deviceTest`)
> as a raw TCP mapping to Mihomo. The results below remain unchanged as
> historical evidence.

## Implemented path

```text
Compose Activity
  -> Kotlin foreground service
  -> Bare Kit Worklet
  -> Kepos HyperDHT subscriber
  -> one Protomux publisher connection
  -> 127.0.0.1:17480 hostname gateway
     127.0.0.1:17481 Navidrome fallback
```

The Android app is subscriber-only. Its identity and publisher contact stay in
app-private storage owned by the Worklet. Kotlin receives the subscriber public
key and sanitized status, but never the subscriber secret key.

## Repeatable device result

The following gate passed on the Pixel 7a:

```sh
npm run android:device-check
```

The command targets the isolated `io.github.ttalab.kepos.devicetest` package
and ports 18480/18481. It does not install over the dogfood app or reuse its
subscriber state. Use `npm run android:install` to update the dogfood debug app
with `adb install -r` while preserving its app-private identity.

The instrumentation test proved that the real subscriber Worklet:

- creates and preserves one subscriber identity;
- accepts a publisher public key over the framed control channel;
- starts the fixed loopback listeners while that test publisher is unreachable;
- answers control pings before and after Activity recreation;
- keeps the same runtime ID, subscriber key, and Navidrome URLs;
- closes the Worklet and foreground service after explicit Stop.

With notification permission reset on the Pixel 7a, tapping Start displayed
the Android notification permission prompt. After the operator allowed it, the
foreground service started and Android exposed the ongoing Kepos notification
with its Stop action. Denial handling remains part of later ship-UI work; it
does not prevent the subscriber service itself from starting.

The test publisher key is intentionally unreachable. This verifies the offline
side of the lifecycle without treating it as evidence of successful NAT
traversal.

### Service-first UI gate (2026-07-23)

The production debug package was updated in place on the same Pixel 7a. After
reconnecting, the native service home read the live publisher Registry and
showed the publisher display name plus Forgejo, Navidrome, SSH, and Woodpecker
in publisher order. It hid Home, used the same portal mark as `kepos-web`, and
showed `http://navidrome.localhost:17480/` as Navidrome's Copy URL action.
The compact service directory keeps all four cards and their secondary text in
the Pixel 7a's initial viewport without scrolling while retaining 48 dp action
targets.
Newsreader and IBM Plex Sans/Mono are bundled with their OFL license texts;
service and action symbols use the pinned Compose Lucide package.

The isolated device gate now also checks that:

- service actions use the real Registry URLs, including the secondary Copy
  address action;
- publisher controls and diagnostics stay in Settings;
- a failed runtime can open Diagnostics and retry;
- reconnect keeps known services visible while disabling their actions;
- initial setup copies the subscriber key needed for publisher allowlisting;
- connecting keeps Settings and publisher reconfiguration reachable;
- explicit Stop remains stopped across Activity recreation until Start;
- unknown service IDs remain TCP unless Kepos recognizes them as web services;
- Activity recreation keeps the same Worklet runtime and loopback listeners.

Android 16 required AndroidX Test 1.7.0 and Espresso 3.7.0. The device test
grants its own notification permission so a previous manual choice cannot
change the result.

On 2026-07-22, `adb install -r` updated the dogfood app to the heartbeat build
without uninstalling it. The subscriber public-key fingerprint before and
after the update was identical, confirming that the app-private identity was
preserved. The embedded Android bundle was also checked byte-for-byte against
the generated bundle and contained `kepos/control/1` and the heartbeat timeout
path. The isolated `npm run android:device-check` gate then passed again on the
same device without replacing or stopping the dogfood package.

`npm run check` also passed 155 tests and its coverage thresholds.
`npm run android:check` passed Kotlin/JVM tests, lint, the Bare bundle, and debug
assembly. The full isolated device gate passed 8/8 on the Pixel 7a and again on
an API 35 arm64 emulator after the review fixes.

The arm64-only debug APK is 89 MiB. Before applying the intended spike ABI
filter, one APK contained four copies of Bare Kit and its addons and was 345
MiB. Emulator/x86 packaging and store-grade ABI splits remain distribution
work.

## Device failures found

The first real subscriber listener used the browser `AbortController` global.
Bare does not provide it. Accepting a local socket raised an uncaught
`ReferenceError`, and Bare Kit aborted the Worklet process with SIGABRT.

Kepos now uses a small runtime-neutral cancellation signal shared by Node and
Bare. Focused tests cover prompt cancellation, client disconnect, and destroying
a tunnel that resolves after cancellation. The device lifecycle gate passed
after this replacement.

## Bounded offline behavior

- One DHT connection candidate times out after 20 seconds and is destroyed.
- Background retry uses the existing capped exponential delay.
- HTTP tunnel acquisition returns `503 Service Unavailable` with
  `Retry-After: 1` after 10 seconds.
- Raw TCP acquisition closes the local socket after 10 seconds.
- Closing a local client cancels its own acquisition without cancelling the
  shared publisher reconnect.
- Listener ports stay fixed while the publisher reconnects.

## Public-path and Navic acceptance

The public-path checks below ran without `adb reverse` or a configured Android
HTTP proxy. The publisher observed the Android peer at a public IPv4 endpoint,
rather than through a LAN-only shortcut. No credential or subscriber secret
was collected.

- [x] Android connects to the allowlisted kosmos-wsl publisher. The publisher
      accepted subscriber `80745ccfb5cb1ec8...` and kept one outer connection.
- [x] `http://home.localhost:17480/` loads in Brave on Android and reports the
      `kosmos` Home online.
- [x] Navic logs in and plays through `http://navidrome.localhost:17480/`.
      Navidrome recorded `player="Navic [Navic]"` while playing `自从有了你`,
      and the Android outer connection transferred about 15 MB during the same
      session. This proves the hostname route on the initial cellular path; it
      does not prove that Navic preserves hostname resolution after a network
      change.
- [x] Playback continues with the screen locked. A focused seven-minute spike
      run stayed in `PLAYING`, advanced across three queue items, kept the same
      Kepos PID, and returned HTTP 200 from port 17480 throughout. A 30-minute
      soak is deferred to Stage B2 rather than used as a Stage B1 merge gate.
- [x] Kepos recovers across Wi-Fi to cellular to Wi-Fi while the foreground
      service stays in the same Android process and keeps the same subscriber
      key. The publisher observed the old outer close and a new outer connect
      after each switch. The fixed numeric fallback
      `http://127.0.0.1:17481/` returned HTTP 200 within 10 seconds on cellular
      and within 25 seconds after returning to Wi-Fi. The app PID and both
      localhost listeners remained unchanged.
- [ ] Navic playback using the hostname URL recovers across the same switch.
      An earlier run reached `UnknownHostException` for
      `navidrome.localhost`; the numeric fallback proves Kepos transport
      recovery but does not fix that client resolver gap.
- [ ] Restarting the kosmos-wsl publisher recovers without restarting the app.
- [x] Android process recreation restores the listener and subscriber identity.
      Killing PID 28338 produced PID 3738 after three seconds. The foreground
      service and port 17480 returned, `/healthz` recovered from 503 to 200,
      and the publisher accepted the same subscriber key on a new outer
      connection without reopening the Activity.
- [ ] Idle memory, CPU, and a 30-minute unplugged battery sample are recorded.

The first idle sample showed 81,219 KiB total PSS, 151,856 KiB total RSS, and
0.0% instantaneous CPU. During the short locked-screen run, total PSS ranged
from 48,105 to 87,036 KiB. The device was connected to AC at 80%, so a real
battery-drain sample remains Stage B2 work. Its purpose is not to prove tunnel
correctness. It is a release-risk check that the foreground service, DHT
keepalive, and reconnect policy do not cause abnormal idle drain. It is not a
Stage B1 merge gate.

No private key, Navidrome credential, auth cookie, or raw state file belongs in
this document.

## Mihomo mixed-proxy acceptance (2026-07-29)

The production debug package was updated in place with `adb install -r` on the
same Pixel 7a. The app remained connected to `kosmos-wsl`, and its subscriber
fingerprint stayed `e7cd23d4…547be77e`, confirming that the update preserved
the existing app-private identity. The isolated `deviceTest` package did not
reuse or replace that state.

The production Registry showed the expected BookOrbit and Mihomo entries.
Mihomo Dashboard was absent because the publisher Registry did not expose it
to this subscriber; the client did not invent a local service entry.

The fixed production listener at `127.0.0.1:17890` passed both TCP proxy modes:

- an HTTP proxy request to `https://example.com` returned HTTP 200;
- a SOCKS5h request to `https://example.com` returned HTTP 200.

Those two host-side probes used a temporary ADB forward to the phone listener.
The forward was removed after the checks. Telegram used the phone loopback
directly, configured as SOCKS5 at `127.0.0.1:17890` with blank username and
password. Telegram reported Connected. With Wi-Fi disabled and mobile data
enabled, the operator sent a normal Telegram message successfully. Wi-Fi was
then restored.

The isolated `npm run android:device-check` gate passed 10/10 on the Pixel 7a,
including lifecycle recreation and the raw Mihomo listener. This acceptance
proves HTTP proxy and SOCKS5 TCP traffic only; it makes no UDP proxy claim.

The first Wi-Fi/cellular sample ran with the device's existing Clash VPN
enabled. Android logs showed Kepos UDP using its configured proxy, so that
sample proves the foreground lifecycle, outer replacement, and loopback
recovery, not a pure direct-P2P route.

The sample was then repeated after the operator stopped Clash. Android had no
Clash process, `tun0`, VPN route, or configured HTTP proxy in this path. On
Wi-Fi, the publisher accepted a private-LAN outer directly from the Pixel and
replaced the older proxy-backed outer. Disabling Wi-Fi closed that LAN outer;
one second later the publisher accepted a new outer from the phone's public
IPv4 path. The numeric Navidrome fallback returned HTTP 200 within 10 seconds.

Re-enabling Wi-Fi created another private-LAN outer. Once its control channel
was ready, the publisher emitted `outer.replaced` and closed the cellular
outer. The app kept the same PID and subscriber public-key fingerprint, and
Home, hostname-routed Navidrome, and the numeric fallback all returned HTTP
200. A simultaneous Mac check also kept Home, Navidrome, and SSH working
through its independent subscriber outer.
