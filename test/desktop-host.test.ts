import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import {
  startDesktopHost,
  type DesktopHostDependencies,
  type DesktopNativeWebView,
  type DesktopNativeWindow,
} from "../apps/desktop/src/host.js";
import type { RunningDesktopRuntime } from "../apps/desktop/src/runtime.js";

const publisherKey = "e4".repeat(32);

test("desktop host acquires its singleton before opening one control window", async () => {
  const harness = createHarness();
  const host = await startDesktopHost(
    {
      homeDirectory: "/Users/neil",
      stateDir: "/state/subscriber",
      gatewayPort: 17_480,
      services: [{ id: "ssh", localPort: 2222 }],
    },
    harness.dependencies,
  );

  assert.deepEqual(harness.events.slice(0, 5), [
    "singleton:acquire:/Users/neil",
    "subscriber-lock:acquire:/state/subscriber",
    "window:create:720x620",
    "webview:create",
    "window:content",
  ]);
  assert.match(harness.webViews[0]?.html ?? "", /<title>Kepos<\/title>/);
  assert.equal(harness.schedules.length, 1);

  harness.webViews[0]?.emit("message", JSON.stringify({ type: "ready" }));
  await harness.flushCommands();
  assert.equal(
    JSON.parse(harness.webViews[0]?.messages.at(-1) ?? "null").connection,
    "connected",
  );

  harness.webViews[0]?.emit(
    "message",
    JSON.stringify({ type: "openService", serviceId: "forgejo" }),
  );
  await harness.flushCommands();
  assert.equal(harness.windows.length, 1);
  assert.deepEqual(harness.webViews[0]?.externalUrls, [
    "http://forgejo.localhost:17480/",
  ]);

  await host.shutdown();
  await host.shutdown();
  assert.equal(harness.events.filter((event) => event === "runtime:stop").length, 1);
  assert.equal(
    harness.events.filter((event) => event === "singleton:release").length,
    1,
  );
  assert.equal(harness.events.filter((event) => event === "exit:0").length, 1);
  assert.equal(harness.webViews.every(({ destroyed }) => destroyed), true);
});

test("desktop host rejects a second process without creating a window", async () => {
  const harness = createHarness({ singletonFailure: "already running" });

  await assert.rejects(
    startDesktopHost(
      {
        homeDirectory: "/Users/neil",
        stateDir: "/state/subscriber",
        gatewayPort: 17_480,
        services: [],
      },
      harness.dependencies,
    ),
    /already running/,
  );
  assert.equal(harness.windows.length, 0);
  assert.equal(harness.webViews.length, 0);
});

test("desktop host rejects a CLI collision before creating a window", async () => {
  const harness = createHarness({ subscriberLockFailure: "state already in use" });

  await assert.rejects(
    startDesktopHost(
      {
        homeDirectory: "/Users/neil",
        stateDir: "/state/subscriber",
        gatewayPort: 17_480,
        services: [],
      },
      harness.dependencies,
    ),
    /state already in use/,
  );
  assert.equal(harness.windows.length, 0);
  assert.deepEqual(harness.events, [
    "singleton:acquire:/Users/neil",
    "subscriber-lock:acquire:/state/subscriber",
    "singleton:release",
  ]);
});

test("native close and UI quit share one ordered shutdown", async () => {
  const harness = createHarness();
  await startDesktopHost(
    {
      homeDirectory: "/Users/neil",
      stateDir: "/state/subscriber",
      gatewayPort: 17_480,
      services: [],
    },
    harness.dependencies,
  );
  harness.webViews[0]?.emit("message", JSON.stringify({ type: "ready" }));
  harness.windows[0]?.emit("willClose");
  harness.webViews[0]?.emit("message", JSON.stringify({ type: "quit" }));
  await harness.flushCommands();

  assert.deepEqual(
    harness.events.filter((event) =>
      [
        "schedule:cancel",
        "runtime:stop",
        "subscriber-lock:release",
        "webview:destroy",
        "singleton:release",
        "exit:0",
      ].includes(event),
    ),
    [
      "schedule:cancel",
      "runtime:stop",
      "subscriber-lock:release",
      "webview:destroy",
      "singleton:release",
      "exit:0",
    ],
  );
});

test("closing during startup stops a runtime that resolves late", async () => {
  let resolveRuntime: ((runtime: RunningDesktopRuntime) => void) | undefined;
  const harness = createHarness({
    startRuntime: () => new Promise((resolve) => {
      resolveRuntime = resolve;
    }),
  });
  const startTask = startDesktopHost(
    {
      homeDirectory: "/Users/neil",
      stateDir: "/state/subscriber",
      gatewayPort: 17_480,
      services: [],
    },
    harness.dependencies,
  );

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

test("shutdown completes cleanup after runtime stop fails", async () => {
  const harness = createHarness({ runtimeStopFailure: "stop failed" });
  const host = await startDesktopHost(
    {
      homeDirectory: "/Users/neil",
      stateDir: "/state/subscriber",
      gatewayPort: 17_480,
      services: [],
    },
    harness.dependencies,
  );

  await assert.rejects(host.shutdown(), /stop failed/);
  assert.equal(harness.webViews[0]?.destroyed, true);
  assert.equal(harness.windows[0]?.closed, true);
  assert.equal(harness.events.includes("singleton:release"), true);
  assert.equal(harness.events.includes("exit:1"), true);
});

interface HarnessOptions {
  singletonFailure?: string;
  subscriberLockFailure?: string;
  runtimeStopFailure?: string;
  startRuntime?: DesktopHostDependencies["startRuntime"];
}

function createHarness(options: HarnessOptions = {}) {
  const events: string[] = [];
  const windows: FakeWindow[] = [];
  const webViews: FakeWebView[] = [];
  const schedules: Array<() => void> = [];
  let runtimeOptions:
    | Parameters<DesktopHostDependencies["startRuntime"]>[0]
    | undefined;

  const runtime: RunningDesktopRuntime = {
    poll: async () => {
      events.push("runtime:poll");
    },
    stop: async () => {
      events.push("runtime:stop");
      events.push("subscriber-lock:release");
      if (options.runtimeStopFailure) {
        throw new Error(options.runtimeStopFailure);
      }
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
    acquireSubscriberLock: async (stateDir) => {
      events.push(`subscriber-lock:acquire:${stateDir}`);
      if (options.subscriberLockFailure) {
        throw new Error(options.subscriberLockFailure);
      }
      return {
        release: async () => {
          events.push("subscriber-lock:release");
        },
      };
    },
    createWindow: (width, height) => {
      events.push(`window:create:${width}x${height}`);
      const window = new FakeWindow(events);
      windows.push(window);
      return window;
    },
    createWebView: () => {
      events.push("webview:create");
      const view = new FakeWebView(events);
      webViews.push(view);
      return view;
    },
    startRuntime: options.startRuntime ?? (async (runtimeStartOptions) => {
      runtimeOptions = runtimeStartOptions;
      runtimeStartOptions.onSnapshot({
        type: "snapshot",
        phase: "running",
        connection: "connected",
        publisher: { displayName: "kosmos", keyFingerprint: publisherKey.slice(0, 16) },
        gatewayPort: 17_480,
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
          {
            id: "navidrome",
            name: "Navidrome",
            access: "http",
            action: "copy-url",
            icon: "music",
            available: true,
            url: "http://navidrome.localhost:17480",
            copyText: "http://navidrome.localhost:17480",
          },
        ],
      });
      return runtime;
    }),
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
    schedules,
    runtime,
    async flushCommands() {
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (runtimeOptions === undefined) throw new Error("runtime did not start");
    },
  };
}

class FakeWindow extends EventEmitter implements DesktopNativeWindow {
  closed = false;

  constructor(private readonly events: string[]) {
    super();
  }

  content(_view: DesktopNativeWebView): this {
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
}

class FakeWebView extends EventEmitter implements DesktopNativeWebView {
  destroyed = false;
  html?: string;
  externalUrls: string[] = [];
  messages: string[] = [];

  constructor(private readonly events: string[]) {
    super();
  }

  loadHTML(html: string): this {
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
