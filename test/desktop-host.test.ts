import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createDesktopDiagnosticSink } from "../apps/desktop/src/diagnostics.js";
import {
  startDesktopHost,
  type DesktopHostDependencies,
  type DesktopNativeWebView,
  type DesktopNativeWindow,
  type StartDesktopHostOptions,
} from "../apps/desktop/src/host.js";
import type { DesktopOptions } from "../apps/desktop/src/options.js";
import type { DesktopSnapshot } from "../apps/desktop/src/protocol.js";
import { DEFAULT_GATEWAY_PORT } from "../src/home/gateway.js";
import { loadDesktopOptions } from "../apps/desktop/src/options.js";
import { acquireDesktopSingleton } from "../apps/desktop/src/singleton.js";
import { setupSubscriber } from "../src/state/subscriber.js";
import type { RunningDesktopRuntime } from "../apps/desktop/src/runtime.js";
import type { DesktopTray } from "../apps/desktop/src/tray.js";

const remotePublisherKey = "e4".repeat(32);

test("desktop host acquires dual-role locks before one control window", async () => {
  const harness = createHarness();
  const host = await startDesktopHost(dualOptions(), harness.dependencies);

  assert.deepEqual(
    harness.events
      .filter(
        (event) => !event.startsWith("tray:add:") && event !== "tray:separator",
      )
      .slice(0, 7),
    [
      "singleton:acquire:/Users/neil",
      "publisher-lock:acquire:/state/publisher",
      "subscriber-lock:acquire:/state/subscriber",
      "window:create:720x620",
      "webview:create",
      "tray:create",
      "window:content",
    ],
  );
  assert.equal(harness.runtimeOptions?.publisher?.stateDir, "/state/publisher");
  assert.equal(
    harness.runtimeOptions?.subscriber?.stateDir,
    "/state/subscriber",
  );
  assert.match(harness.webViews[0]?.html ?? "", /<title>Kepos<\/title>/);
  assert.equal(harness.schedules.length, 1);

  harness.webViews[0]?.emit("message", JSON.stringify({ type: "ready" }));
  await harness.flushCommands();
  assert.equal(
    JSON.parse(harness.webViews[0]?.messages.at(-1) ?? "null").subscriber
      .connection,
    "connected",
  );

  harness.webViews[0]?.emit(
    "message",
    JSON.stringify({ type: "openService", serviceId: "forgejo" }),
  );
  await harness.flushCommands();
  assert.deepEqual(harness.webViews[0]?.externalUrls, [
    "http://forgejo.localhost:17480/",
  ]);

  await host.shutdown();
  await host.shutdown();
  assert.equal(
    harness.events.filter((event) => event === "runtime:stop").length,
    1,
  );
  assert.equal(
    harness.events.filter((event) => event === "singleton:release").length,
    1,
  );
  assert.equal(harness.events.filter((event) => event === "exit:0").length, 1);
});

test("desktop host copies pre-command diagnostics through the controller", async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), "kepos-desktop-host-diagnostics-"),
  );
  const diagnostics = createDesktopDiagnosticSink({
    directory: root,
    platform: "win32",
  });
  await diagnostics.ready;
  const harness = createHarness();
  let host: { shutdown(): Promise<void> } | undefined;
  try {
    host = await startDesktopHost(
      {
        ...subscriberOptions(),
        diagnostics,
      },
      harness.dependencies,
    );
    diagnostics.observe({
      component: "kepos",
      timestamp: "2026-08-10T12:00:00.000Z",
      elapsedMs: 1,
      event: "channel.close",
      role: "subscriber",
      outerId: "outer-0123456789abcdef",
      bytes: 123,
    });

    const webView = harness.webViews[0];
    assert.ok(webView);
    webView.emit("message", JSON.stringify({ type: "ready" }));
    await harness.flushCommands();
    webView.emit("message", JSON.stringify({ type: "copyDiagnostics" }));
    await harness.flushCommands();

    const result = JSON.parse(webView.messages.at(-1) ?? "null") as {
      type?: string;
      ok?: boolean;
      summary?: string;
    };
    assert.deepEqual(
      { type: result.type, ok: result.ok },
      {
        type: "diagnosticsResult",
        ok: true,
      },
    );
    assert.ok(result.summary);
    const summary = JSON.parse(result.summary) as {
      events: Array<{ outerId?: string }>;
    };
    assert.ok(
      summary.events.some(
        (event) => event.outerId === "outer-0123456789abcdef",
      ),
    );
  } finally {
    await host?.shutdown().catch(() => undefined);
    await diagnostics.shutdown().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop host records only the opt-in rendered-page acknowledgement", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kepos-desktop-rendered-smoke-"));
  const marker = path.join(root, "rendered.marker");
  const message = JSON.stringify({
    type: "windows-smoke-rendered",
    connection: "unconfigured",
    serviceCount: 0,
    subscriberKeyPresent: true,
    connectFormVisible: true,
  });
  let acknowledgement: unknown;
  let resolveAcknowledgement!: () => void;
  const acknowledgementReceived = new Promise<void>((resolve) => {
    resolveAcknowledgement = resolve;
  });
  try {
    const harness = createHarness();
    const host = await startDesktopHost(
      {
        ...subscriberOptions(),
        smokeRenderFile: marker,
        onSmokeRendered: (value) => {
          acknowledgement = value;
          resolveAcknowledgement();
        },
      },
      harness.dependencies,
    );

    assert.match(harness.webViews[0]?.html ?? "", /windows-smoke-rendered/);
    harness.webViews[0]?.emit("message", message);
    await acknowledgementReceived;
    assert.equal(await readFile(marker, "utf8"), `${message}\n`);
    assert.deepEqual(acknowledgement, JSON.parse(message));

    harness.webViews[0]?.emit("message", JSON.stringify({ type: "ready" }));
    // The host captures every bridge message to a diagnostics file before
    // handling commands, so the ready handshake snapshot lands after real
    // filesystem I/O rather than in a microtask. Wait for it instead of
    // assuming a fixed event-loop budget.
    for (
      let attempts = 0;
      attempts < 250 && harness.webViews[0]?.messages.length === 0;
      attempts += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assert.equal(harness.webViews[0]?.messages.length, 1);
    await host.shutdown();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop singleton serializes bootstrap and preserves an existing config", async () => {
  const homeDirectory = await mkdtemp(
    path.join(tmpdir(), "kepos-desktop-concurrent-"),
  );
  const environment = {
    XDG_CONFIG_HOME: path.join(homeDirectory, "config"),
    XDG_STATE_HOME: path.join(homeDirectory, "state"),
  };
  const configPath = path.join(
    environment.XDG_CONFIG_HOME,
    "kepos",
    "config.toml",
  );
  const configSource = "[subscriber]\nenabled = true\nservices = []\n";
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, configSource);

  let setupCount = 0;
  let setupEntered!: () => void;
  const setupStarted = new Promise<void>((resolve) => {
    setupEntered = resolve;
  });
  let releaseSetup!: () => void;
  const setupGate = new Promise<void>((resolve) => {
    releaseSetup = resolve;
  });
  const loadOptions = () =>
    loadDesktopOptions([], {
      homeDirectory,
      environment,
      platform: "linux",
      setupSubscriber: async (options) => {
        setupCount += 1;
        setupEntered();
        await setupGate;
        return setupSubscriber(options);
      },
    });
  const harness = createHarness();
  const dependencies = {
    ...harness.dependencies,
    acquireSingleton: acquireDesktopSingleton,
  };

  try {
    const first = startDesktopHost(
      { homeDirectory, loadOptions },
      dependencies,
    );
    await setupStarted;
    await assert.rejects(
      startDesktopHost({ homeDirectory, loadOptions }, dependencies),
      /desktop is already running/i,
    );
    assert.equal(setupCount, 1);
    releaseSetup();
    const host = await first;
    await host.shutdown();
    assert.equal(await readFile(configPath, "utf8"), configSource);
  } finally {
    releaseSetup();
    await rm(homeDirectory, { recursive: true, force: true });
  }
});

test("desktop host releases the singleton when bootstrap fails", async () => {
  const harness = createHarness();

  await assert.rejects(
    startDesktopHost(
      {
        homeDirectory: "/Users/neil",
        loadOptions: async () => {
          throw new Error("bootstrap failed");
        },
      },
      harness.dependencies,
    ),
    /bootstrap failed/,
  );
  assert.deepEqual(harness.events, [
    "singleton:acquire:/Users/neil",
    "singleton:release",
  ]);
});

test("desktop host restores pairing after runtime setup failure and retries", async () => {
  const harness = createHarness();
  const subscriberKey = "cd".repeat(32);
  const firstPublisherKey = "ab".repeat(32);
  const replacementPublisherKey = "ef".repeat(32);
  const persisted: string[] = [];
  const reconfigured: Array<Parameters<RunningDesktopRuntime["reconfigure"]>[0]> = [];
  let publishSnapshot: ((snapshot: DesktopSnapshot) => void) | undefined;
  let configuredAttempts = 0;
  const runtime: RunningDesktopRuntime = {
    ...harness.runtime,
    reconfigure: async (configuration) => {
      reconfigured.push(configuration);
      if (configuration.subscriber?.subscriberSetup?.configured === false) {
        publishSnapshot?.({
          type: "snapshot",
          appPhase: "running",
          subscriber: {
            phase: "running",
            connection: "unconfigured",
            subscriberKey,
            services: [],
            ...(configuration.subscriber.subscriberSetup.error
              ? { error: configuration.subscriber.subscriberSetup.error }
              : {}),
          },
        });
        return;
      }
      configuredAttempts += 1;
      if (configuredAttempts < 3) throw new Error("subscriber start failed");
      publishSnapshot?.({
        type: "snapshot",
        appPhase: "running",
        subscriber: {
          phase: "running",
          connection: "connected",
          subscriberKey,
          remotePublisher: {
            displayName: "publisher",
            publisherKey: replacementPublisherKey,
            keyFingerprint: replacementPublisherKey.slice(0, 16),
          },
          services: [],
        },
      });
    },
  };
  const dependencies: DesktopHostDependencies = {
    ...harness.dependencies,
    setSubscriberPublisher: async (options) => {
      persisted.push(options.publisherKey);
    },
    startRuntime: async (startOptions) => {
      publishSnapshot = startOptions.onSnapshot;
      startOptions.onSnapshot({
        type: "snapshot",
        appPhase: "running",
        subscriber: {
          phase: "running",
          connection: "unconfigured",
          subscriberKey,
          services: [],
        },
      });
      return runtime;
    },
  };
  const host = await startDesktopHost(
    desktopHostOptions({
      ...subscriberDesktopOptions(),
      subscriber: {
        ...subscriberDesktopOptions().subscriber!,
        subscriberSetup: { configured: false, publicKey: subscriberKey },
      },
    }),
    dependencies,
  );

  harness.webViews[0]?.emit("message", JSON.stringify({ type: "ready" }));
  for (const publisherKey of [
    firstPublisherKey,
    firstPublisherKey,
    replacementPublisherKey,
  ]) {
    harness.webViews[0]?.emit(
      "message",
      JSON.stringify({ type: "setSubscriberPublisher", publisherKey }),
    );
    await harness.flushCommands();
  }

  assert.deepEqual(persisted, [firstPublisherKey, replacementPublisherKey]);
  assert.equal(configuredAttempts, 3);
  assert.equal(reconfigured.length, 5);
  assert.equal(
    JSON.parse(harness.webViews[0]?.messages.at(-1) ?? "null").subscriber
      .connection,
    "connected",
  );
  assert.equal(
    JSON.parse(harness.webViews[0]?.messages.at(-1) ?? "null").subscriber
      .subscriberKey,
    subscriberKey,
  );
  await host.shutdown();
});

test("desktop host republishes unconfigured state when persistence fails and retries", async () => {
  const harness = createHarness();
  const subscriberKey = "cd".repeat(32);
  const publisherKey = "ef".repeat(32);
  const persisted: string[] = [];
  let publishSnapshot: ((snapshot: DesktopSnapshot) => void) | undefined;
  let persistenceAttempts = 0;
  const runtime: RunningDesktopRuntime = {
    ...harness.runtime,
    reconfigure: async (configuration) => {
      if (configuration.subscriber?.subscriberSetup?.configured === false) {
        publishSnapshot?.({
          type: "snapshot",
          appPhase: "running",
          subscriber: {
            phase: "running",
            connection: "unconfigured",
            subscriberKey,
            services: [],
            ...(configuration.subscriber.subscriberSetup.error
              ? { error: configuration.subscriber.subscriberSetup.error }
              : {}),
          },
        });
        return;
      }
      publishSnapshot?.({
        type: "snapshot",
        appPhase: "running",
        subscriber: {
          phase: "running",
          connection: "connected",
          subscriberKey,
          remotePublisher: {
            displayName: "publisher",
            publisherKey,
            keyFingerprint: publisherKey.slice(0, 16),
          },
          services: [],
        },
      });
    },
  };
  const dependencies: DesktopHostDependencies = {
    ...harness.dependencies,
    setSubscriberPublisher: async (options) => {
      persisted.push(options.publisherKey);
      persistenceAttempts += 1;
      if (persistenceAttempts === 1) {
        throw new Error("persistence failed");
      }
    },
    startRuntime: async (startOptions) => {
      publishSnapshot = startOptions.onSnapshot;
      startOptions.onSnapshot({
        type: "snapshot",
        appPhase: "running",
        subscriber: {
          phase: "running",
          connection: "unconfigured",
          subscriberKey,
          services: [],
        },
      });
      return runtime;
    },
  };
  const host = await startDesktopHost(
    desktopHostOptions({
      ...subscriberDesktopOptions(),
      subscriber: {
        ...subscriberDesktopOptions().subscriber!,
        subscriberSetup: { configured: false, publicKey: subscriberKey },
      },
    }),
    dependencies,
  );

  harness.webViews[0]?.emit("message", JSON.stringify({ type: "ready" }));
  harness.webViews[0]?.emit(
    "message",
    JSON.stringify({ type: "setSubscriberPublisher", publisherKey }),
  );
  await harness.flushCommands();

  // Persistence failed before saving; the submit must stay retryable through
  // an unconfigured snapshot carrying the error, not hang in flight.
  const afterFailure = JSON.parse(
    harness.webViews[0]?.messages.at(-1) ?? "null",
  );
  assert.equal(afterFailure.subscriber.connection, "unconfigured");
  assert.equal(afterFailure.subscriber.phase, "running");
  assert.equal(afterFailure.subscriber.error, "persistence failed");
  assert.equal(afterFailure.subscriber.subscriberKey, subscriberKey);
  assert.deepEqual(persisted, [publisherKey]);

  // A later submit retries persistence and completes the connection.
  harness.webViews[0]?.emit(
    "message",
    JSON.stringify({ type: "setSubscriberPublisher", publisherKey }),
  );
  await harness.flushCommands();

  assert.deepEqual(persisted, [publisherKey, publisherKey]);
  assert.equal(
    JSON.parse(harness.webViews[0]?.messages.at(-1) ?? "null").subscriber
      .connection,
    "connected",
  );
  await host.shutdown();
});

test("desktop host supports publisher-only mode", async () => {
  const harness = createHarness();
  const host = await startDesktopHost(
    desktopHostOptions({ publisher: { stateDir: "/state/publisher" } }),
    harness.dependencies,
  );

  assert.equal(
    harness.events.includes("publisher-lock:acquire:/state/publisher"),
    true,
  );
  assert.equal(
    harness.events.some((event) => event.startsWith("subscriber-lock")),
    false,
  );
  await host.shutdown();
});

test("desktop host supports subscriber-only mode", async () => {
  const harness = createHarness();
  const host = await startDesktopHost(
    subscriberOptions(),
    harness.dependencies,
  );

  assert.equal(
    harness.events.includes("subscriber-lock:acquire:/state/subscriber"),
    true,
  );
  assert.equal(
    harness.events.some((event) => event.startsWith("publisher-lock")),
    false,
  );
  await host.shutdown();
});

test("desktop host forwards configured role policy to the runtime", async () => {
  const harness = createHarness();
  const bootstrap = [{ host: "bootstrap.example", port: 49_737 }];
  const policy = {
    displayName: "Configured publisher",
    subscribers: [],
    services: [],
  };
  const options = dualDesktopOptions();
  Object.assign(options, { bootstrap });
  Object.assign(options.publisher ?? {}, { policy });
  Object.assign(options.subscriber ?? {}, { route: "public" });
  const host = await startDesktopHost(
    desktopHostOptions(options),
    harness.dependencies,
  );

  assert.deepEqual(harness.runtimeOptions?.bootstrap, bootstrap);
  assert.deepEqual(harness.runtimeOptions?.publisher?.policy, policy);
  assert.equal(harness.runtimeOptions?.subscriber?.route, "public");
  await host.shutdown();
});

test("desktop host exposes in-process role reconfiguration", async () => {
  const harness = createHarness();
  const host = await startDesktopHost(
    subscriberOptions(),
    harness.dependencies,
  );

  await host.reconfigure({
    publisher: { stateDir: "/state/publisher" },
  });

  assert.equal(harness.events.includes("runtime:reconfigure"), true);
  await host.shutdown();
});

test("desktop host rejects a second process without creating a window", async () => {
  const harness = createHarness({ singletonFailure: "already running" });

  await assert.rejects(
    startDesktopHost(subscriberOptions(), harness.dependencies),
    /already running/,
  );
  assert.equal(harness.windows.length, 0);
});

test("desktop host releases acquired locks when the next role lock fails", async () => {
  const publisherFailure = createHarness({
    publisherLockFailure: "publisher in use",
  });
  await assert.rejects(
    startDesktopHost(dualOptions(), publisherFailure.dependencies),
    /publisher in use/,
  );
  assert.deepEqual(publisherFailure.events, [
    "singleton:acquire:/Users/neil",
    "publisher-lock:acquire:/state/publisher",
    "singleton:release",
  ]);

  const subscriberFailure = createHarness({
    subscriberLockFailure: "subscriber in use",
  });
  await assert.rejects(
    startDesktopHost(dualOptions(), subscriberFailure.dependencies),
    /subscriber in use/,
  );
  assert.deepEqual(subscriberFailure.events, [
    "singleton:acquire:/Users/neil",
    "publisher-lock:acquire:/state/publisher",
    "subscriber-lock:acquire:/state/subscriber",
    "publisher-lock:release",
    "singleton:release",
  ]);
});

test("desktop host preserves lock failure while attempting all prior releases", async () => {
  const harness = createHarness({
    subscriberLockFailure: "subscriber in use",
    publisherLockReleaseFailure: "publisher release failed",
  });

  await assert.rejects(
    startDesktopHost(dualOptions(), harness.dependencies),
    /subscriber in use/,
  );
  assert.equal(harness.events.includes("publisher-lock:release"), true);
  assert.equal(harness.events.includes("singleton:release"), true);
});

test("native close and UI quit share one ordered dual-role shutdown", async () => {
  const harness = createHarness();
  await startDesktopHost(dualOptions(), harness.dependencies);
  harness.webViews[0]?.emit("message", JSON.stringify({ type: "ready" }));
  harness.windows[0]?.emit("willClose");
  harness.webViews[0]?.emit("message", JSON.stringify({ type: "quit" }));
  await harness.flushCommands();

  assert.deepEqual(
    harness.events.filter((event) =>
      [
        "schedule:cancel",
        "runtime:stop",
        "publisher-lock:release",
        "subscriber-lock:release",
        "webview:destroy",
        "singleton:release",
        "exit:0",
      ].includes(event),
    ),
    [
      "schedule:cancel",
      "runtime:stop",
      "publisher-lock:release",
      "subscriber-lock:release",
      "webview:destroy",
      "singleton:release",
      "exit:0",
    ],
  );
});

test("tray Open and Quit retain one window and one shutdown", async () => {
  const harness = createHarness();
  await startDesktopHost(dualOptions(), harness.dependencies);
  harness.trays[0]?.emit("select", "open");
  assert.equal(harness.events.includes("window:show"), true);
  assert.equal(harness.events.includes("runtime:stop"), false);

  harness.trays[0]?.emit("select", "quit");
  harness.trays[0]?.emit("select", "quit");
  await harness.flushCommands();
  assert.equal(
    harness.events.filter((event) => event === "tray:destroy").length,
    1,
  );
  assert.equal(
    harness.events.filter((event) => event === "runtime:stop").length,
    1,
  );
  assert.ok(
    harness.events.indexOf("tray:destroy") <
      harness.events.indexOf("runtime:stop"),
  );
});

test("native red close hides without tearing down host state", async () => {
  const harness = createHarness();
  const host = await startDesktopHost(dualOptions(), harness.dependencies);

  harness.windows[0]?.redClose();

  assert.equal(harness.windows[0]?.visible, false);
  assert.equal(harness.windows[0]?.closed, false);
  assert.equal(harness.webViews[0]?.destroyed, false);
  assert.equal(harness.trays[0]?.destroyed, false);
  assert.equal(harness.schedules.length, 1);
  assert.equal(harness.events.includes("runtime:stop"), false);
  assert.equal(harness.events.includes("publisher-lock:release"), false);
  assert.equal(harness.events.includes("subscriber-lock:release"), false);
  assert.equal(harness.events.includes("singleton:release"), false);

  harness.trays[0]?.emit("select", "open");
  assert.equal(harness.windows[0]?.visible, true);
  await host.shutdown();
});

test("shutdown detaches tray before stop-time snapshots", async () => {
  const harness = createHarness({ publishStopSnapshots: true });
  const host = await startDesktopHost(dualOptions(), harness.dependencies);
  const updatesBeforeShutdown = harness.trays[0]?.updates.length;

  await host.shutdown();

  assert.equal(harness.trays[0]?.updates.length, updatesBeforeShutdown);
  assert.ok(
    harness.events.indexOf("tray:destroy") <
      harness.events.indexOf("runtime:stop"),
  );
});

test("tray menu setup failure destroys every created native resource", async () => {
  const harness = createHarness({ trayMenuFailure: true });
  await assert.rejects(
    startDesktopHost(dualOptions(), harness.dependencies),
    /tray menu failed/,
  );
  assert.equal(harness.events.includes("tray:destroy"), true);
  assert.equal(harness.events.includes("webview:destroy"), true);
  assert.equal(harness.events.includes("window:close"), true);
  assert.equal(harness.events.includes("singleton:release"), true);
});

test("closing during startup stops a runtime that resolves late", async () => {
  let resolveRuntime: ((runtime: RunningDesktopRuntime) => void) | undefined;
  const harness = createHarness({
    startRuntime: () =>
      new Promise((resolve) => {
        resolveRuntime = resolve;
      }),
  });
  const startTask = startDesktopHost(dualOptions(), harness.dependencies);

  await new Promise((resolve) => setTimeout(resolve, 0));
  harness.windows[0]?.emit("willClose");
  resolveRuntime?.(harness.runtime);
  await startTask;
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(harness.events.includes("runtime:stop"), true);
  assert.equal(harness.schedules.length, 0);
  assert.equal(harness.webViews[0]?.destroyed, true);
  assert.equal(harness.events.includes("singleton:release"), true);
});

test("shutdown completes host cleanup after runtime stop fails", async () => {
  const harness = createHarness({ runtimeStopFailure: "stop failed" });
  const host = await startDesktopHost(dualOptions(), harness.dependencies);

  await assert.rejects(host.shutdown(), /stop failed/);
  assert.equal(harness.webViews[0]?.destroyed, true);
  assert.equal(harness.windows[0]?.closed, true);
  assert.equal(harness.events.includes("singleton:release"), true);
  assert.equal(harness.events.includes("exit:1"), true);
});

for (const nativeFailure of [
  "window",
  "webview",
  "tray",
  "content",
  "load",
] as const) {
  test(`desktop host releases every lock when native ${nativeFailure} setup fails`, async () => {
    const harness = createHarness({ nativeFailure });

    await assert.rejects(
      startDesktopHost(dualOptions(), harness.dependencies),
      new RegExp(`${nativeFailure} failed`),
    );
    assert.equal(
      harness.events.filter((event) => event === "publisher-lock:release")
        .length,
      1,
    );
    assert.equal(
      harness.events.filter((event) => event === "subscriber-lock:release")
        .length,
      1,
    );
    assert.equal(
      harness.events.filter((event) => event === "singleton:release").length,
      1,
    );
  });
}

function desktopHostOptions(options: DesktopOptions): StartDesktopHostOptions {
  return {
    homeDirectory: "/Users/neil",
    loadOptions: async () => options,
  };
}

function subscriberDesktopOptions(): DesktopOptions {
  return {
    subscriber: {
      stateDir: "/state/subscriber",
      gatewayPort: DEFAULT_GATEWAY_PORT,
      services: [{ id: "ssh", localPort: 2222 }],
    },
  };
}

function dualDesktopOptions(): DesktopOptions {
  return {
    ...subscriberDesktopOptions(),
    publisher: { stateDir: "/state/publisher" },
  };
}

function subscriberOptions(): StartDesktopHostOptions {
  return desktopHostOptions(subscriberDesktopOptions());
}

function dualOptions(): StartDesktopHostOptions {
  return desktopHostOptions(dualDesktopOptions());
}

interface HarnessOptions {
  singletonFailure?: string;
  publisherLockFailure?: string;
  publisherLockReleaseFailure?: string;
  subscriberLockFailure?: string;
  runtimeStopFailure?: string;
  publishStopSnapshots?: boolean;
  trayMenuFailure?: boolean;
  startRuntime?: DesktopHostDependencies["startRuntime"];
  nativeFailure?: "window" | "webview" | "tray" | "content" | "load";
}

function createHarness(options: HarnessOptions = {}) {
  const events: string[] = [];
  const windows: FakeWindow[] = [];
  const webViews: FakeWebView[] = [];
  const trays: FakeTray[] = [];
  const schedules: Array<() => void> = [];
  let runtimeOptions:
    Parameters<DesktopHostDependencies["startRuntime"]>[0] | undefined;

  const runtime: RunningDesktopRuntime = {
    approvePairing: async () => undefined,
    cancelPairing: async () => undefined,
    createPairingInvitation: async () => undefined,
    denyPairing: async () => undefined,
    poll: async () => {
      events.push("runtime:poll");
    },
    reconfigure: async () => {
      events.push("runtime:reconfigure");
    },
    stop: async () => {
      events.push("runtime:stop");
      if (options.publishStopSnapshots) {
        runtimeOptions?.onSnapshot({ type: "snapshot", appPhase: "stopping" });
        runtimeOptions?.onSnapshot({ type: "snapshot", appPhase: "stopped" });
      }
      if (runtimeOptions?.publisher) events.push("publisher-lock:release");
      if (runtimeOptions?.subscriber) events.push("subscriber-lock:release");
      if (options.runtimeStopFailure)
        throw new Error(options.runtimeStopFailure);
    },
  };
  const dependencies: DesktopHostDependencies = {
    acquireSingleton: async (homeDirectory) => {
      events.push(`singleton:acquire:${homeDirectory}`);
      if (options.singletonFailure) throw new Error(options.singletonFailure);
      return {
        release: async () => {
          events.push("singleton:release");
        },
      };
    },
    acquirePublisherLock: async (stateDir) => {
      events.push(`publisher-lock:acquire:${stateDir}`);
      if (options.publisherLockFailure)
        throw new Error(options.publisherLockFailure);
      return {
        release: async () => {
          events.push("publisher-lock:release");
          if (options.publisherLockReleaseFailure) {
            throw new Error(options.publisherLockReleaseFailure);
          }
        },
      };
    },
    acquireSubscriberLock: async (stateDir) => {
      events.push(`subscriber-lock:acquire:${stateDir}`);
      if (options.subscriberLockFailure)
        throw new Error(options.subscriberLockFailure);
      return {
        release: async () => {
          events.push("subscriber-lock:release");
        },
      };
    },
    createWindow: (width, height) => {
      events.push(`window:create:${width}x${height}`);
      if (options.nativeFailure === "window") throw new Error("window failed");
      const window = new FakeWindow(
        events,
        options.nativeFailure === "content",
      );
      windows.push(window);
      return window;
    },
    createWebView: () => {
      events.push("webview:create");
      if (options.nativeFailure === "webview")
        throw new Error("webview failed");
      const view = new FakeWebView(events, options.nativeFailure === "load");
      webViews.push(view);
      return view;
    },
    createTray: () => {
      events.push("tray:create");
      if (options.nativeFailure === "tray") throw new Error("tray failed");
      const tray = new FakeTray(events, options.trayMenuFailure);
      trays.push(tray);
      return tray;
    },
    startRuntime:
      options.startRuntime ??
      (async (startOptions) => {
        runtimeOptions = startOptions;
        startOptions.onSnapshot({
          type: "snapshot",
          appPhase: "running",
          subscriber: startOptions.subscriber
              ? {
                phase: "running",
                connection: "connected",
                subscriberKey: "cd".repeat(32),
                remotePublisher: {
                  displayName: "kosmos",
                  publisherKey: remotePublisherKey,
                  keyFingerprint: remotePublisherKey.slice(0, 16),
                },
                gatewayPort: DEFAULT_GATEWAY_PORT,
                services: [
                  {
                    id: "forgejo",
                    name: "Forgejo",
                    access: "http",
                    action: "open",
                    icon: "git",
                    available: true,
                    url: "http://forgejo.localhost:17480/",
                  },
                ],
              }
            : undefined,
          publisher: startOptions.publisher
            ? {
                phase: "running",
                displayName: "This Mac",
                publisherKey: "a7".repeat(32),
                keyFingerprint: "a7".repeat(8),
                activeSubscribers: 0,
                activeSubscriberKeys: [],
                acceptedConnections: 0,
                services: [],
              }
            : undefined,
        });
        return runtime;
      }),
    setSubscriberPublisher: async () => undefined,
    schedulePoll: (callback) => {
      schedules.push(callback);
      return () => events.push("schedule:cancel");
    },
    exit: (code) => events.push(`exit:${code}`),
  };

  return {
    dependencies,
    events,
    windows,
    webViews,
    trays,
    schedules,
    runtime,
    get runtimeOptions() {
      return runtimeOptions;
    },
    async flushCommands() {
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

class FakeWindow extends EventEmitter implements DesktopNativeWindow {
  closed = false;
  visible = true;

  constructor(
    private readonly events: string[],
    private readonly contentFailure = false,
  ) {
    super();
  }

  content(_view: DesktopNativeWebView): this {
    if (this.contentFailure) throw new Error("content failed");
    this.events.push("window:content");
    return this;
  }

  close(): this {
    if (this.closed) return this;
    this.closed = true;
    this.events.push("window:close");
    this.emit("willClose");
    return this;
  }

  redClose(): void {
    this.visible = false;
  }

  show(): this {
    this.visible = true;
    this.events.push("window:show");
    return this;
  }
}

class FakeTray extends EventEmitter implements DesktopTray {
  destroyed = false;
  updates: Array<{ id: string; title?: string; enabled?: boolean }> = [];

  constructor(
    private readonly events: string[],
    private readonly menuFailure = false,
  ) {
    super();
  }

  addItem(
    id: string,
    title: string,
    options: { enabled?: boolean } = {},
  ): this {
    if (this.menuFailure) throw new Error("tray menu failed");
    this.events.push(`tray:add:${id}`);
    this.updates.push({ id, title, ...options });
    return this;
  }

  addSeparator(): this {
    this.events.push("tray:separator");
    return this;
  }

  updateItem(id: string, options: { title?: string; enabled?: boolean }): this {
    if (this.destroyed) throw new Error("update after tray destroy");
    this.updates.push({ id, ...options });
    return this;
  }

  destroy(): this {
    if (this.destroyed) return this;
    this.destroyed = true;
    this.events.push("tray:destroy");
    return this;
  }
}

class FakeWebView extends EventEmitter implements DesktopNativeWebView {
  destroyed = false;
  html?: string;
  externalUrls: string[] = [];
  messages: string[] = [];

  constructor(
    private readonly events: string[],
    private readonly loadFailure = false,
  ) {
    super();
  }

  loadHTML(html: string): this {
    if (this.loadFailure) throw new Error("load failed");
    this.html = html;
    return this;
  }

  openExternal(url: string): this {
    this.externalUrls.push(url);
    return this;
  }

  postMessage(message: string): this {
    this.messages.push(message);
    return this;
  }

  destroy(): this {
    if (this.destroyed) return this;
    this.destroyed = true;
    this.events.push("webview:destroy");
    return this;
  }
}
