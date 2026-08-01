# Proposed bounty: Capacitor Bare Kit for Android

Status: Draft for scope review  
Proposed payout: 4,000 USD₮  
Target: Android, Capacitor 8

## Summary

Build and publish an Apache-2.0 Capacitor plugin that embeds one Bare Kit
Worklet in an Android application. The plugin will load an application-owned
Bare bundle, expose bounded binary IPC to the WebView, and keep Worklet
ownership stable across Android Activity recreation.

Applications can choose process-scoped ownership for foreground-only work or
enable foreground-service ownership for a user-visible, long-running Worklet.
The service mode includes notification management, Activity reattachment, and
an explicit process-restart policy. It does not bypass Android background-work
or Google Play rules.

## Problem

Bare Kit provides native Android bindings, and Holepunch maintains integrations
for React Native and Expo. Capacitor applications can call native Kotlin or Java
code, but there is no public, maintained Capacitor-to-Bare Kit integration.
Each application must currently rebuild the same Worklet loading, IPC,
lifecycle, error, and TypeScript bridge code.

Existing Capacitor foreground-service plugins solve notification and Android
process-priority concerns. They do not own a Bare Worklet or provide Bare IPC,
so this task does not duplicate a generic foreground-service plugin. Its
optional service is specifically the owner and supervisor of a Bare Worklet.

## Proposed API

The exact names may change during maintainer review, but the public surface must
cover these capabilities:

```ts
interface BareKitPlugin {
  getState(): Promise<{ state: "stopped" | "starting" | "running" | "failed" }>;
  start(options: {
    bundle: string;
    arguments?: string[];
    memoryLimitBytes?: number;
    ownership?:
      | { mode: "process" }
      | {
          mode: "foreground-service";
          restartAfterProcessDeath?: boolean;
          notification: {
            channelId: string;
            id: number;
            title: string;
            body: string;
            smallIcon: string;
          };
        };
  }): Promise<void>;
  send(options: { data: string }): Promise<void>;
  stop(): Promise<void>;
  addListener(
    event: "data" | "error" | "stateChanged",
    listener: (event: unknown) => void,
  ): Promise<{ remove(): Promise<void> }>;
}
```

`data` is base64 at the Capacitor JSON boundary and bytes on both sides of that
boundary. The plugin must not parse product messages or prescribe an RPC
schema.

## Deliverables

1. An npm-installable Capacitor 8 plugin with Android native sources and
   TypeScript types.
2. An Android host that owns at most one active Bare Worklet and is independent
   of any Activity or WebView instance. It supports process-scoped ownership
   and optional foreground-service ownership through the same client API.
3. Safe loading of a packaged `.bundle` from application assets, with bounded
   `arguments` and memory-limit configuration. Web content cannot supply an
   arbitrary filesystem path or remote URL.
4. Bidirectional binary IPC with explicit handling for partial reads, EOF,
   write failure, Worklet failure, duplicate start, and idempotent stop.
5. Foreground-service mode with a required user-visible notification, explicit
   desired-running state, Activity reattachment, optional restart after process
   death, and explicit stop that clears restart intent.
6. A minimal Capacitor example that starts an echo Worklet in both ownership
   modes, exchanges binary fixtures, survives Activity recreation, reports
   failure, and stops cleanly.
7. Automated TypeScript, JVM, and Android instrumentation tests, plus one
   documented physical-device acceptance run.
8. Setup, API, lifecycle, foreground-service policy, security, compatibility,
   and troubleshooting documentation.
9. An Apache-2.0 release in the repository and package location agreed with the
   Bare maintainers before implementation starts.

## Acceptance criteria

The task is accepted when all of the following are observable:

- A new Capacitor 8 Android project can install the package, bundle the example
  Worklet, and build without copying Kotlin source into the application.
- `start()` reaches `running` and the example completes byte-for-byte echo
  exchanges for empty-adjacent, fragmented, and maximum-supported fixtures.
- A second `start()` cannot create a duplicate Worklet and returns a documented
  result or error.
- Recreating the Android Activity and Capacitor Bridge does not create a second
  Worklet. A new WebView listener can attach to the existing process-scoped
  host and continue IPC.
- With default process ownership, the plugin starts no foreground service and
  requests no foreground-service capability.
- With foreground-service ownership enabled, the service displays the supplied
  notification, owns the Worklet independently of the Activity, and accepts a
  newly created Capacitor Bridge as a client without restarting the Worklet.
- Worklet startup failure, IPC EOF, malformed base64, oversized input, and
  native write failure produce bounded, documented errors rather than a hang
  or uncaught exception.
- `stop()` closes IPC and the Worklet, rejects pending work, reaches `stopped`,
  and remains safe when called again.
- After Android kills the application process, process ownership reports
  `stopped` on the next launch. Foreground-service ownership restarts the
  packaged Worklet only when `restartAfterProcessDeath` was enabled and the
  desired-running state was not cleared by an explicit stop.
- In foreground-service mode, `stop()` closes the Worklet, removes the
  notification, stops the Service, and prevents sticky resurrection.
- Unit and instrumentation test suites pass in CI, and the same start, echo,
  Activity-recreation, process-restart, and stop flows pass on a physical arm64
  Android device.

## Non-goals

- iOS or web implementations.
- A generic foreground-service or notification plugin unrelated to Bare Kit.
- A background-start exemption, boot receiver, or promise that Android will
  allow indefinite execution under every device policy.
- Automatically choosing, misdeclaring, or bypassing Android
  foreground-service types or Google Play policy. The consuming application
  must declare a valid type, permissions, and Play Console use case.
- Kotlin RPC generation, Hyperschema support, or a product-specific message
  protocol.
- Hypercore, HyperDHT, Hyperswarm, or Protomux wrappers.
- Remote bundle loading, over-the-air updates, or arbitrary filesystem access.
- React Native, Expo, Electron, Pear desktop, or UI framework components.
- Multiple concurrent Worklets in the first release.

## Suggested milestone split

The payout is fixed at 4,000 USD₮ for the accepted task. If milestone payments
are supported, the suggested split is:

1. Plugin scaffold, asset loading, process-scoped host, and start/stop tests:
   30%.
2. Binary IPC, both ownership modes, lifecycle behavior, process restart, and
   failure-path tests: 40%.
3. Example application, physical-device evidence, documentation, and release:
   30%.

Payment for completed milestones should depend on the agreed technical
criteria, not package download counts or adoption by third parties.

## Existing proof

[Kepos Neo](https://github.com/tta-lab/kepos-neo) is an Apache-2.0 application
that already runs a Bare Kit Worklet behind a native Kotlin/Compose Android UI.
Its reusable host covers Worklet ownership, framed IPC, state transitions,
failure handling, and physical-device lifecycle tests.

A separate private dogfood application has independently exercised the other
side of the proposed integration: a Capacitor 8 WebView calling through a
Kotlin plugin into a Bare Kit Worklet with Corestore, Hypercore, HyperDHT,
Hyperswarm, and Protomux. It is supporting evidence, not a deliverable and not
material to be relicensed under this task.

## Scope questions for Tether and Holepunch

These points must be settled before implementation:

1. Does Holepunch want to own the repository and npm package from day one, or
   accept a transfer after the first release?
2. Which Bare Kit release and minimum Android API should be the compatibility
   baseline?
3. Should the JavaScript API mirror `react-native-bare-kit` where Capacitor's
   JSON bridge permits, or prefer Capacitor conventions?
4. Is upstream repository acceptance part of the final milestone only, with
   earlier milestones payable on technical acceptance?
5. Which foreground-service types should the example document and exercise?
   `specialUse` is broadly applicable but requires a clear manifest use case
   and Google Play review; the library must not select it silently.

## References

- [Bare Kit](https://github.com/holepunchto/bare-kit)
- [React Native Bare Kit](https://github.com/holepunchto/react-native-bare-kit)
- [Expo Bare Kit](https://github.com/holepunchto/expo-bare-kit)
- [Bare on Android example](https://github.com/holepunchto/bare-android)
- [Capacitor Android foreground service](https://capawesome.io/docs/sdks/capacitor/android-foreground-service/)
- [Tether developer grants](https://tether.dev/grants/apply-for-a-grant/)
