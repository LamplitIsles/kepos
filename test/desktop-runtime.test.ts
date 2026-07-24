import assert from "node:assert/strict";
import { test } from "node:test";

import {
  startDesktopRuntime,
  type DesktopRuntimeDependencies,
} from "../apps/desktop/src/runtime.js";
import type { HomeRegistry } from "../src/home/registry.js";
import type {
  SubscriberRuntimeStatus,
  RunningSubscriber,
} from "../src/runtime/subscriber.js";

const publisherKey = "e4".repeat(32);
const registry: HomeRegistry = {
  schemaVersion: 2,
  revision: 1,
  publisher: { displayName: "kosmos", publisherKey },
  services: [
    { id: "home", name: "Home", kind: "tcp" },
    { id: "navidrome", name: "Navidrome", kind: "tcp" },
    { id: "ssh", name: "SSH", kind: "tcp" },
  ],
};

test("desktop runtime uses the shared service handlers and action order", async () => {
  const snapshots: unknown[] = [];
  const richRegistry: HomeRegistry = {
    ...registry,
    services: [
      { id: "home", name: "Home", kind: "tcp" },
      { id: "navidrome", name: "Navidrome", kind: "tcp" },
      { id: "ente-storage", name: "Ente Storage", kind: "tcp" },
      { id: "ssh", name: "SSH", kind: "tcp" },
      { id: "forgejo", name: "Forgejo", kind: "tcp" },
      { id: "ente", name: "Ente Photos", kind: "tcp" },
      { id: "woodpecker", name: "Woodpecker", kind: "tcp" },
    ],
  };
  const desktop = await startDesktopRuntime(
    {
      stateDir: "/state/subscriber",
      gatewayPort: 17_480,
      services: [{ id: "ssh", localPort: 2222 }],
      onSnapshot: (snapshot) => snapshots.push(snapshot),
    },
    {
      acquireSubscriberLock: async () => ({ release: async () => {} }),
      startSubscriber: async () => runningSubscriber(
        () => subscriberStatus("connected"),
        [],
      ),
      readRegistry: async () => richRegistry,
    },
  );

  assert.deepEqual(
    (snapshots.at(-1) as { services: unknown[] }).services,
    [
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
        id: "woodpecker",
        name: "Woodpecker",
        access: "http",
        action: "open",
        icon: "build",
        available: true,
        url: "http://woodpecker.localhost:17480/",
      },
      {
        id: "ssh",
        name: "SSH",
        access: "ssh",
        action: "copy-command",
        icon: "terminal",
        available: true,
        copyText: "ssh -p 2222 127.0.0.1",
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
      {
        id: "ente-storage",
        name: "Ente Storage",
        access: "http",
        action: "copy-url",
        icon: "storage",
        available: true,
        url: "http://ente-storage.localhost:17480",
        copyText: "http://ente-storage.localhost:17480",
      },
      {
        id: "ente",
        name: "Ente Photos",
        access: "http",
        action: "copy-url",
        icon: "photos",
        available: true,
        url: "http://ente.localhost:17480",
        copyText: "http://ente.localhost:17480",
      },
    ],
  );

  await desktop.stop();
});

test("desktop runtime publishes real services across reconnect generations", async () => {
  const events: string[] = [];
  const snapshots: unknown[] = [];
  let registryReads = 0;
  let status = subscriberStatus("connected", 1);
  const running = runningSubscriber(() => status, events);
  const dependencies: DesktopRuntimeDependencies = {
    acquireSubscriberLock: async () => ({
      release: async () => {
        events.push("lock:release");
      },
    }),
    startSubscriber: async (options) => {
      events.push(`subscriber:start:${options.stateDir}`);
      return running;
    },
    readRegistry: async () => {
      registryReads++;
      return registry;
    },
  };

  const desktop = await startDesktopRuntime(
    {
      stateDir: "/state/subscriber",
      gatewayPort: 17_480,
      services: [{ id: "ssh", localPort: 2222 }],
      onSnapshot: (snapshot) => snapshots.push(snapshot),
    },
    dependencies,
  );

  assert.deepEqual(snapshots, [
    {
      type: "snapshot",
      phase: "starting",
      connection: "connecting",
      services: [],
    },
    {
      type: "snapshot",
      phase: "running",
      connection: "connected",
      publisher: {
        displayName: "kosmos",
        keyFingerprint: publisherKey.slice(0, 16),
      },
      gatewayPort: 17_480,
      services: [
        {
          id: "ssh",
          name: "SSH",
          access: "ssh",
          action: "copy-command",
          icon: "terminal",
          available: true,
          copyText: "ssh -p 2222 127.0.0.1",
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
    },
  ]);
  assert.equal(registryReads, 1);

  status = subscriberStatus("reconnecting", 1);
  await desktop.poll();
  assert.deepEqual(
    (snapshots.at(-1) as { services: Array<{ available: boolean }> }).services.map(
      ({ available }) => available,
    ),
    [false, false],
  );

  status = subscriberStatus("connected", 2);
  await desktop.poll();
  assert.equal(registryReads, 2);
  assert.deepEqual(
    (snapshots.at(-1) as { services: Array<{ available: boolean }> }).services.map(
      ({ available }) => available,
    ),
    [true, true],
  );

  await desktop.stop();
  await desktop.stop();
  assert.deepEqual(events, [
    "subscriber:start:/state/subscriber",
    "subscriber:stop",
    "lock:release",
  ]);
  assert.deepEqual(snapshots.at(-1), {
    type: "snapshot",
    phase: "stopped",
    connection: "stopped",
    publisher: {
      displayName: "kosmos",
      keyFingerprint: publisherKey.slice(0, 16),
    },
    gatewayPort: 17_480,
    services: [
      {
        id: "ssh",
        name: "SSH",
        access: "ssh",
        action: "copy-command",
        icon: "terminal",
        available: false,
        copyText: "ssh -p 2222 127.0.0.1",
      },
      {
        id: "navidrome",
        name: "Navidrome",
        access: "http",
        action: "copy-url",
        icon: "music",
        available: false,
        url: "http://navidrome.localhost:17480",
        copyText: "http://navidrome.localhost:17480",
      },
    ],
  });
});

test("desktop runtime starts while its publisher is unavailable", async () => {
  let startOptions: Parameters<DesktopRuntimeDependencies["startSubscriber"]>[0]
    | undefined;
  let registryReads = 0;
  const snapshots: unknown[] = [];
  const desktop = await startDesktopRuntime(
    {
      stateDir: "/state/subscriber",
      gatewayPort: 17_480,
      services: [],
      onSnapshot: (snapshot) => snapshots.push(snapshot),
    },
    {
      acquireSubscriberLock: async () => ({ release: async () => {} }),
      startSubscriber: async (options) => {
        startOptions = options;
        return runningSubscriber(
          () => subscriberStatus("reconnecting", 0),
          [],
        );
      },
      readRegistry: async () => {
        registryReads++;
        return registry;
      },
    },
  );

  assert.equal(startOptions?.waitForPublisher, false);
  assert.equal(registryReads, 0);
  assert.equal(
    (snapshots.at(-1) as { connection: string }).connection,
    "reconnecting",
  );
  await desktop.stop();
});

test("desktop runtime refreshes after a reconnect missed between polls", async () => {
  let generation = 1;
  let registryReads = 0;
  const desktop = await startDesktopRuntime(
    {
      stateDir: "/state/subscriber",
      gatewayPort: 17_480,
      services: [],
      onSnapshot: () => {},
    },
    {
      acquireSubscriberLock: async () => ({ release: async () => {} }),
      startSubscriber: async () => runningSubscriber(
        () => subscriberStatus("connected", generation),
        [],
      ),
      readRegistry: async () => {
        registryReads++;
        return registry;
      },
    },
  );

  assert.equal(registryReads, 1);
  generation = 2;
  await desktop.poll();
  assert.equal(registryReads, 2);
  await desktop.stop();
});

test("desktop runtime releases its subscriber lock when startup fails", async () => {
  const events: string[] = [];
  const snapshots: unknown[] = [];
  const dependencies: DesktopRuntimeDependencies = {
    acquireSubscriberLock: async () => ({
      release: async () => {
        events.push("lock:release");
      },
    }),
    startSubscriber: async () => {
      throw new Error("publisher unavailable");
    },
    readRegistry: async () => registry,
  };

  await assert.rejects(
    startDesktopRuntime(
      {
        stateDir: "/state/subscriber",
        gatewayPort: 17_480,
        services: [],
        onSnapshot: (snapshot) => snapshots.push(snapshot),
      },
      dependencies,
    ),
    /publisher unavailable/,
  );
  assert.deepEqual(events, ["lock:release"]);
  assert.deepEqual(snapshots.at(-1), {
    type: "snapshot",
    phase: "failed",
    connection: "stopped",
    services: [],
    error: "publisher unavailable",
  });
});

test("desktop runtime cleans up when its initial running snapshot fails", async () => {
  const events: string[] = [];
  let snapshots = 0;
  await assert.rejects(
    startDesktopRuntime(
      {
        stateDir: "/state/subscriber",
        gatewayPort: 17_480,
        services: [],
        onSnapshot: () => {
          snapshots++;
          if (snapshots === 2) throw new Error("snapshot failed");
        },
      },
      {
        acquireSubscriberLock: async () => ({
          release: async () => {
            events.push("lock:release");
          },
        }),
        startSubscriber: async () => runningSubscriber(
          () => subscriberStatus("connected", 1),
          events,
        ),
        readRegistry: async () => registry,
      },
    ),
    /snapshot failed/,
  );

  assert.deepEqual(events, ["subscriber:stop", "lock:release"]);
});

test("desktop runtime keeps its lock until failed startup shutdown finishes", async () => {
  const events: string[] = [];
  let finishStop: (() => void) | undefined;
  const startTask = startDesktopRuntime(
    {
      stateDir: "/state/subscriber",
      gatewayPort: 17_480,
      services: [],
      onSnapshot: (snapshot) => {
        if (snapshot.phase === "running") throw new Error("snapshot failed");
      },
    },
    {
      acquireSubscriberLock: async () => ({
        release: async () => {
          events.push("lock:release");
        },
      }),
      startSubscriber: async () => ({
        ...runningSubscriber(() => subscriberStatus("connected", 1), events),
        stop: async () => {
          events.push("stop:start");
          await new Promise<void>((resolve) => {
            finishStop = resolve;
          });
          events.push("stop:finish");
        },
      }),
      readRegistry: async () => registry,
    },
  );

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(events, ["stop:start"]);
  finishStop?.();
  await assert.rejects(startTask, /snapshot failed/);
  assert.deepEqual(events, ["stop:start", "stop:finish", "lock:release"]);
});

test("desktop runtime suppresses a late poll snapshot after stop", async () => {
  let generation = 1;
  let resolveRegistry: ((value: HomeRegistry) => void) | undefined;
  let registryReads = 0;
  const snapshots: Array<{ phase: string; connection: string }> = [];
  const desktop = await startDesktopRuntime(
    {
      stateDir: "/state/subscriber",
      gatewayPort: 17_480,
      services: [],
      onSnapshot: (snapshot) => snapshots.push(snapshot),
    },
    {
      acquireSubscriberLock: async () => ({ release: async () => {} }),
      startSubscriber: async () => runningSubscriber(
        () => subscriberStatus("connected", generation),
        [],
      ),
      readRegistry: async () => {
        registryReads++;
        if (registryReads === 1) return registry;
        return new Promise((resolve) => {
          resolveRegistry = resolve;
        });
      },
    },
  );

  generation = 2;
  const pollTask = desktop.poll();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await desktop.stop();
  resolveRegistry?.(registry);
  await pollTask;

  assert.deepEqual(snapshots.slice(-2).map(({ phase, connection }) => ({
    phase,
    connection,
  })), [
    { phase: "stopping", connection: "connected" },
    { phase: "stopped", connection: "stopped" },
  ]);
});

test("desktop runtime cleans up when a stopping snapshot fails", async () => {
  const events: string[] = [];
  const desktop = await startDesktopRuntime(
    {
      stateDir: "/state/subscriber",
      gatewayPort: 17_480,
      services: [],
      onSnapshot: (snapshot) => {
        if (snapshot.phase === "stopping") throw new Error("snapshot failed");
      },
    },
    {
      acquireSubscriberLock: async () => ({
        release: async () => {
          events.push("lock:release");
        },
      }),
      startSubscriber: async () => runningSubscriber(
        () => subscriberStatus("connected", 1),
        events,
      ),
      readRegistry: async () => registry,
    },
  );

  await assert.rejects(desktop.stop(), /snapshot failed/);
  assert.deepEqual(events, ["subscriber:stop", "lock:release"]);
});

function subscriberStatus(
  connection: SubscriberRuntimeStatus["connection"],
  connectionGeneration = connection === "connected" ? 1 : 0,
): SubscriberRuntimeStatus {
  return {
    role: "subscriber",
    state: connection === "stopped" ? "stopped" : "running",
    connection,
    connectionGeneration,
    publisherKey,
    homeUrl: "http://home.localhost:17480",
    services: [{ id: "ssh", port: 2222 }],
  };
}

function runningSubscriber(
  status: () => SubscriberRuntimeStatus,
  events: string[],
): RunningSubscriber {
  return {
    publisherKey,
    home: { port: 17_480, url: "http://home.localhost:17480" },
    services: [{ id: "ssh", port: 2222 }],
    status,
    stop: async () => {
      events.push("subscriber:stop");
    },
  };
}
