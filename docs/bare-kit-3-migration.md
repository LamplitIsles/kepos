# Bare Kit 3 migration assessment

The Apple packet tunnel now uses Bare Kit 3 through the pinned bare-kit-swift
bindings. Source-built iOS and macOS extension frameworks and all four native
addons have passed offline cross-linking and the checks described in
[Building the Apple extension frameworks](ios-extension-safe.md). Apple native
linking, a complete prohibited-API audit, signing and device execution remain
unverified. The official precompiled frameworks are not substitutes for the
source-built extension artifacts.

## Pinned upstream inputs

* [bare-kit-swift v2.2.0](https://github.com/holepunchto/bare-kit-swift/tree/753f4fcca2f9fde40692fcdaf24d5c5c66b9b0da)
  builds against [bare-kit v3.0.1](https://github.com/holepunchto/bare-kit/tree/9cd80b8ba96e591b222987a80f394012e19d45b0),
  which specifies Bare v1.36.2. Its Swift package supports iOS 15 and macOS
  13 or newer; Kepos targets iOS 17 and its Mac build targets macOS 15.
* The [official v2.2.0 XCFramework release](https://github.com/holepunchto/bare-kit-swift/releases/tag/v2.2.0)
  lists `BareKit.xcframework.zip`, 55,271,532 bytes, SHA-256
  `b902db426fd9ed1bc1c73cc5048a9a9f22799dc0972f2e0c70fab3d6561fb3e2`.
  The downloaded archive matched both. It contains iOS arm64, a universal
  macOS framework and simulator slices. Only the first two were extracted.
* The official iOS arm64 binary declares minimum iOS 15 and SDK 18.5, but
  lacks `MH_APP_EXTENSION_SAFE`, loads UIKit, and imports `UIApplication` and
  `UIBackgroundTaskInvalid`. Its selectors include `sharedApplication` and
  background-task operations. The official macOS x86_64 and arm64 binaries
  declare minimum macOS 13 and SDK 15.5 and lack the extension-safe flag.
  No UIKit or UIApplication imports were observed in the Mac binaries, but
  ld64.lld rejected the arm64 framework in an extension-safety link. Neither
  the flag nor the selected import checks alone establish API safety or Apple
  acceptance.

## Migration changes and remaining evidence

| Area | Previous behavior, current implementation and remaining evidence |
| --- | --- |
| Swift and C API | The 2.x provider used Objective-C `BareWorklet` and `BareIPC`. Both Apple build paths now compile the pinned 3.x Swift `Worklet` and `IPC` bindings over the new C API. `Worklet.start` throws, writes are async and reads use an async sequence. The provider cross-linked for both platforms; native Apple execution remains unverified. |
| Worklet IPC | The [3.x API](https://docs.pears.com/bare/release-overview/) replaces `BareKit.IPC` with `Bare.IPC`. The entry uses `Bare.IPC`, which the previously pinned 2.5.5 worklet also exposed. The original isolated probe reached a fake bridge with that global; it did not execute the native runtime. |
| Startup and buffering | The 2.x startup helper started before opening IPC; the [Swift 3.x binding](https://github.com/holepunchto/bare-kit-swift/tree/753f4fcca2f9fde40692fcdaf24d5c5c66b9b0da) opens IPC before starting. The provider retains its 32-frame output bound, asynchronous backpressure and generation checks. Isolated framing and failure tests passed; native runtime behavior remains unverified. |
| Exit and identity lock | `wait()` reports the exit callback after runtime teardown, before the native thread finally returns; `end()` half-closes IPC. The provider waits for both the `stopped` response and successful teardown before releasing the identity `flock`; an unconfirmed teardown retains the fail-closed process-termination path. Isolated tests cover both event orders, nonzero exit and real lock release after simulated process exit, not the native NetworkExtension lifecycle. |
| Extension safety | [bare-kit 3.0.1](https://github.com/holepunchto/bare-kit/blob/9cd80b8ba96e591b222987a80f394012e19d45b0/src/CMakeLists.txt) ordinarily selects iOS UIKit suspension. The extension-only iOS source build uses the non-UIKit suspension implementation; macOS retains its normal non-iOS path. Both source builds use extension compiler and linker checks. Flag, architecture, selected import, selector and library checks passed, but are not a complete prohibited-API audit. |
| Native addons | The original comparison found all 9, 13, 48 and 79 old-runtime-resolved import names in the official new iOS runtime; this was only a symbol probe. The four addons have since been rebuilt for each platform against the source-built runtime. Offline worklet packaging, addon mapping and registration checks passed; native execution remains unverified. |
| Build provenance | Bare v1.36.2 specifies [Hyperdrive checkout 198](https://github.com/holepunchto/bare/blob/v1.36.2/CMakeLists.txt), distinct from checkout 159. Fixed platform metadata and required prebuilds were obtained, the build tools were pinned separately from shared production `node_modules`, and the builds ran offline with implicit fetch disabled. Preparing all v3 inputs from a clean environment is not yet automated. |
| Security and platforms | Identity preservation, unknown pairing outcomes, route checks and packet authorization remain required; invitations must not be replayed. Cross-linking and static inspection do not establish iPhone or Mac operation, memory use, signing, sandbox behavior or network reachability. |

The verified upstream archive and extracted official frameworks remain under
`.build/ios-deps/bare-kit-swift-v2.2.0/`; they are not extension-safe production
artifacts. The original metadata-only checkout 198 probe listed the iOS
`libc++.a` (1,874,688 bytes), `libjs.a` (472,024 bytes), and `libv8.a`
(51,888,408 bytes), for 54,235,120 bytes total. The libc++ and V8 entries use
the same ranges as checkout 159 in the same metadata core and derived content
core. Their retained files matched the locally recorded checkout 159 SHA-256
values, not independently published upstream file hashes. The required iOS and
Mac prebuilt inputs were subsequently obtained or verified for the source builds.
