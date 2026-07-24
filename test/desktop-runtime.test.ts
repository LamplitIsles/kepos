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
        access: "tcp",
        action: "info",
        icon: "storage",
        available: true,
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
  let status = subscriberStatus("connected");
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

  status = subscriberStatus("reconnecting");
  await desktop.poll();
  assert.deepEqual(
    (snapshots.at(-1) as { services: Array<{ available: boolean }> }).services.map(
      ({ available }) => available,
    ),
    [false, false],
  );

  status = subscriberStatus("connected");
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

function subscriberStatus(
  connection: SubscriberRuntimeStatus["connection"],
): SubscriberRuntimeStatus {
  return {
    role: "subscriber",
    state: connection === "stopped" ? "stopped" : "running",
    connection,
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
