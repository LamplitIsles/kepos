# ADR 0003: Android subscriber and Bare host boundaries

Status: Accepted (historical subscriber-only spike; canonical production
runtime superseded by ADR 0013)

Date: 2026-07-21

## Context

The subscriber-only production decision in this spike was superseded by ADR
0013. The host/Worklet lifecycle boundary and its test-owned native seams
remain applicable to the canonical peer runtime.

Kepos needs an Android client that keeps a subscriber connection ready while its UI is closed. Android will not publish services. The first spike also needs to tell us whether Bare Kit can host the same JavaScript runtime that may later power the real subscriber.

We want native Android behavior without tying the transport runtime to Compose or making a new cross-platform framework part of the product's critical path.

## Decision

The Android app is subscriber-only and uses native Kotlin with Compose.

The process is split at four explicit seams:

- `android/app` owns Android product behavior: Compose UI, the foreground service, notifications, and user start/stop actions.
- `android/barekit-host` is a generic Kotlin host for one Bare Kit Worklet and its framed IPC lifecycle.
- `packages/bare-host-protocol` is the platform-neutral, versioned control protocol shared by native hosts and Worklets.
- `packages/kepos-android-worklet` contains Kepos product runtime code and no Android UI code.

The foreground service, not the Activity, owns the Worklet. One user start creates at most one Worklet. A user stop asks the Worklet to shut down, waits for its reply, and forces cleanup after a bounded timeout. Closing or destroying the Activity does not stop the service.

Control messages use a versioned, length-prefixed JSON protocol. The shared TypeScript protocol uses `b4a` for bytes because browser `TextEncoder` and `TextDecoder` do not exist in Bare. Kotlin and TypeScript both verify the same wire fixture.

Bare Kit is pinned to 2.3.0 with a fixed URL, size, and SHA-256. This replaces the plan's 2.2.0 because 2.3.0 contains the Android thread-attachment fix and matches our minimum Android API 31 target.

Bare Kit's Android test order is authoritative where its README differs: start the Worklet, create `IPC`, then read. Creating IPC before start caused a reproducible CheckJNI abort on a Pixel 7a.

PR A ends at a persistent loopback echo Worklet. The real Kepos subscriber belongs in PR B after this native lifecycle gate passes.

## Consequences

The Activity can be recreated or closed without reconnecting the runtime. Headless runtime code stays outside the Android app module, and the protocol package can later move to a Bare Native ecosystem project without moving Kepos UI code.

This does not claim that Kepos has built a general cross-platform framework. We will extract a framework only after the same host boundary serves a second real product or platform.

The spike APK includes only `arm64-v8a`, the ABI used by the physical-device gate. This keeps the debug APK from bundling four copies of Bare Kit and its addons. Emulator/x86 artifacts and store-grade ABI splits remain distribution work.
