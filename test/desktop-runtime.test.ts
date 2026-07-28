import assert from "node:assert/strict";
import { test } from "node:test";

import {
  startDesktopRuntime,
  type DesktopRuntimeDependencies,
} from "../apps/desktop/src/runtime.js";
import type { DesktopSnapshot } from "../apps/desktop/src/protocol.js";
import type { HomeRegistry } from "../src/home/registry.js";
import { derivePublisherHomeKey } from "../src/keys.js";
import { HomeRegistryTimeoutError } from "../src/runtime/registry-client.js";
import type {
  PublisherRuntimeStatus,
  RunningPublisher,
} from "../src/runtime/publisher.js";
import type {
  RunningSubscriber,
  StartSubscriberOptions,
  SubscriberRuntimeStatus,
} from "../src/runtime/subscriber.js";

const remotePublisherKey = "e4".repeat(32);
const localPublisherSeed = "11".repeat(32);
const localPublisherKey = derivePublisherHomeKey(localPublisherSeed);
const registry: HomeRegistry = {
  schemaVersion: 2,
  revision: 1,
  publisher: { displayName: "kosmos", publisherKey: remotePublisherKey },
  services: [
    { id: "home", name: "Home", kind: "tcp" },
    { id: "navidrome", name: "Navidrome", kind: "tcp" },
    { id: "ssh", name: "SSH", kind: "tcp" },
    { id: "dagger", name: "Dagger", kind: "tcp" },
  ],
};

test("desktop runtime starts and stops a publisher-only role", async () => {
  const events: string[] = [];
  const snapshots: DesktopSnapshot[] = [];
  let startedPolicy: unknown = "not-started";
  const runtime = await startDesktopRuntime(
    {
      publisher: { stateDir: "/state/publisher" },
      onSnapshot: (snapshot) => snapshots.push(snapshot),
    },
    dependencies(events, {
      startPublisher: async (options) => {
        startedPolicy = options.policy;
        events.push(`publisher:start:${options.stateDir}`);
        return runningPublisher(() => publisherStatus(1, 2), events);
      },
    }),
  );

  assert.equal(startedPolicy, undefined);

  assert.deepEqual(snapshots, [
    {
      type: "snapshot",
      appPhase: "starting",
      publisher: {
        phase: "starting",
        activeSubscribers: 0,
        acceptedConnections: 0,
        services: [],
      },
    },
    {
      type: "snapshot",
      appPhase: "running",
      publisher: {
        phase: "running",
        displayName: "Mac smoke",
        publisherKey: localPublisherKey,
        keyFingerprint: localPublisherKey.slice(0, 16),
        activeSubscribers: 1,
        acceptedConnections: 2,
        services: [
          { id: "smoke", name: "Smoke", targetPort: 18_080 },
        ],
      },
    },
  ]);
  assert.deepEqual(events.slice(0, 3), [
    "publisher-lock:acquire:/state/publisher",
    "publisher-state:load:/state/publisher",
    "publisher:start:/state/publisher",
  ]);

  await runtime.stop();
  await runtime.stop();
  assert.deepEqual(events.slice(-2), [
    "publisher:stop",
    "publisher-lock:release",
  ]);
  assert.equal(snapshots.at(-1)?.appPhase, "stopped");
  assert.equal(snapshots.at(-1)?.publisher?.phase, "stopped");
});

test("desktop runtime keeps subscriber service behavior in subscriber-only mode", async () => {
  const events: string[] = [];
  const snapshots: DesktopSnapshot[] = [];
  let connection: SubscriberRuntimeStatus["connection"] = "connected";
  let generation = 1;
  let registryReads = 0;
  let startedOptions: StartSubscriberOptions | undefined;
  const runtime = await startDesktopRuntime(
    {
      subscriber: {
        stateDir: "/state/subscriber",
        gatewayPort: 17_480,
        gatewayHost: "0.0.0.0",
        gatewayDomain: "kepos.internal",
        services: [
          { id: "ssh", localPort: 2222 },
          { id: "dagger", localPort: 18_080 },
        ],
      },
      onSnapshot: (snapshot) => snapshots.push(snapshot),
    },
    dependencies(events, {
      startSubscriber: async (options) => {
        startedOptions = options;
        return runningSubscriber(
          () =>
            subscriberStatus(connection, generation, [
              { id: "ssh", port: 2222 },
              { id: "dagger", port: 18_080 },
            ]),
          events,
        );
      },
      readRegistry: async () => {
        registryReads++;
        return registry;
      },
    }),
  );

  assert.equal(registryReads, 1);
  assert.equal(startedOptions?.gatewayHost, "0.0.0.0");
  assert.equal(startedOptions?.gatewayDomain, "kepos.internal");
  assert.deepEqual(snapshots.at(-1)?.subscriber, {
    phase: "running",
    connection: "connected",
    remotePublisher: {
      displayName: "kosmos",
      keyFingerprint: remotePublisherKey.slice(0, 16),
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
        id: "dagger",
        name: "Dagger",
        access: "tcp",
        action: "copy-command",
        icon: "dagger",
        available: true,
        copyText:
          "export _EXPERIMENTAL_DAGGER_RUNNER_HOST=tcp://127.0.0.1:18080",
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

  connection = "reconnecting";
  await runtime.poll();
  assert.deepEqual(
    snapshots.at(-1)?.subscriber?.services.map(({ available }) => available),
    [false, false, false],
  );

  connection = "connected";
  generation = 2;
  await runtime.poll();
  assert.equal(registryReads, 2);
  assert.deepEqual(
    snapshots.at(-1)?.subscriber?.services.map(({ available }) => available),
    [true, true, true],
  );
  await runtime.stop();
});

test("desktop runtime invalidates a connected generation after Home times out", async () => {
  const events: string[] = [];
  const snapshots: DesktopSnapshot[] = [];
  let connection: SubscriberRuntimeStatus["connection"] = "connected";
  const timeout = new HomeRegistryTimeoutError(5_000);
  const runtime = await startDesktopRuntime(
    {
      subscriber: {
        stateDir: "/state/subscriber",
        gatewayPort: 17_480,
        services: [],
      },
      onSnapshot: (snapshot) => snapshots.push(snapshot),
    },
    dependencies(events, {
      startSubscriber: async () =>
        runningSubscriber(
          () => subscriberStatus(connection, 1),
          events,
          (generation, reason) => {
            events.push(`subscriber:invalidate:${generation}:${reason}`);
            connection = "reconnecting";
            return true;
          },
        ),
      readRegistry: async () => {
        throw timeout;
      },
    }),
  );

  assert.deepEqual(
    events.filter((event) => event.startsWith("subscriber:invalidate:")),
    ["subscriber:invalidate:1:home.registry.timeout"],
  );
  assert.equal(snapshots.at(-1)?.subscriber?.connection, "reconnecting");
  assert.equal(snapshots.at(-1)?.subscriber?.services.length, 0);

  await runtime.poll();
  assert.equal(
    events.filter((event) => event.startsWith("subscriber:invalidate:")).length,
    1,
  );
  await runtime.stop();
});

test("desktop runtime rate-limits Home-triggered resets across generations", async () => {
  const invalidations: number[] = [];
  let connection: SubscriberRuntimeStatus["connection"] = "connected";
  let generation = 1;
  let now = 0;
  const timeout = new HomeRegistryTimeoutError(5_000);
  const runtime = await startDesktopRuntime(
    {
      subscriber: {
        stateDir: "/state/subscriber",
        gatewayPort: 17_480,
        services: [],
      },
      onSnapshot: () => undefined,
    },
    dependencies([], {
      startSubscriber: async () =>
        runningSubscriber(
          () => subscriberStatus(connection, generation),
          [],
          (invalidatedGeneration) => {
            invalidations.push(invalidatedGeneration);
            connection = "reconnecting";
            return true;
          },
        ),
      readRegistry: async () => {
        throw timeout;
      },
      now: () => now,
      random: () => 0.5,
    } as Partial<DesktopRuntimeDependencies>),
  );

  assert.deepEqual(invalidations, [1]);
  generation = 2;
  connection = "connected";
  await runtime.poll();
  assert.deepEqual(invalidations, [1]);

  now = 30_000;
  await runtime.poll();
  assert.deepEqual(invalidations, [1, 2]);

  generation = 3;
  connection = "connected";
  await runtime.poll();
  now = 149_999;
  await runtime.poll();
  assert.deepEqual(invalidations, [1, 2]);
  now = 151_999;
  await runtime.poll();
  assert.deepEqual(invalidations, [1, 2, 3]);

  generation = 4;
  connection = "connected";
  await runtime.poll();
  now = 451_998;
  await runtime.poll();
  assert.deepEqual(invalidations, [1, 2, 3]);
  now = 453_998;
  await runtime.poll();
  assert.deepEqual(invalidations, [1, 2, 3, 4]);
  await runtime.stop();
});

test("a healthy Home response re-arms immediate reset recovery", async () => {
  const invalidations: number[] = [];
  let connection: SubscriberRuntimeStatus["connection"] = "connected";
  let generation = 1;
  let read = 0;
  const timeout = new HomeRegistryTimeoutError(5_000);
  const runtime = await startDesktopRuntime(
    {
      subscriber: {
        stateDir: "/state/subscriber",
        gatewayPort: 17_480,
        services: [],
      },
      onSnapshot: () => undefined,
    },
    dependencies([], {
      startSubscriber: async () =>
        runningSubscriber(
          () => subscriberStatus(connection, generation),
          [],
          (invalidatedGeneration) => {
            invalidations.push(invalidatedGeneration);
            connection = "reconnecting";
            return true;
          },
        ),
      readRegistry: async () => {
        read++;
        if (read === 2) return registry;
        throw timeout;
      },
      now: () => 0,
      random: () => 0.5,
    } as Partial<DesktopRuntimeDependencies>),
  );

  generation = 2;
  connection = "connected";
  await runtime.poll();
  generation = 3;
  await runtime.poll();

  assert.deepEqual(invalidations, [1, 3]);
  await runtime.stop();
});

test("desktop ignores a stale Home timeout from an older generation", async () => {
  const invalidations: number[] = [];
  let generation = 1;
  let rejectRead: ((error: Error) => void) | undefined;
  let reads = 0;
  const runtime = await startDesktopRuntime(
    {
      subscriber: {
        stateDir: "/state/subscriber",
        gatewayPort: 17_480,
        services: [],
      },
      onSnapshot: () => undefined,
    },
    dependencies([], {
      startSubscriber: async () =>
        runningSubscriber(
          () => subscriberStatus("connected", generation),
          [],
          (invalidatedGeneration) => {
            invalidations.push(invalidatedGeneration);
            return true;
          },
        ),
      readRegistry: async () => {
        reads++;
        if (reads === 1) return registry;
        return new Promise<HomeRegistry>((_resolve, reject) => {
          rejectRead = reject;
        });
      },
    }),
  );

  generation = 2;
  const polling = runtime.poll();
  await new Promise((resolve) => setImmediate(resolve));
  generation = 3;
  rejectRead?.(new HomeRegistryTimeoutError(5_000));
  await polling;

  assert.deepEqual(invalidations, []);
  await runtime.stop();
});

test("desktop ignores a Home timeout that completes after stop begins", async () => {
  const invalidations: number[] = [];
  let generation = 1;
  let rejectRead: ((error: Error) => void) | undefined;
  let reads = 0;
  const runtime = await startDesktopRuntime(
    {
      subscriber: {
        stateDir: "/state/subscriber",
        gatewayPort: 17_480,
        services: [],
      },
      onSnapshot: () => undefined,
    },
    dependencies([], {
      startSubscriber: async () =>
        runningSubscriber(
          () => subscriberStatus("connected", generation),
          [],
          (invalidatedGeneration) => {
            invalidations.push(invalidatedGeneration);
            return true;
          },
        ),
      readRegistry: async () => {
        reads++;
        if (reads === 1) return registry;
        return new Promise<HomeRegistry>((_resolve, reject) => {
          rejectRead = reject;
        });
      },
    }),
  );

  generation = 2;
  const polling = runtime.poll();
  await new Promise((resolve) => setImmediate(resolve));
  const stopping = runtime.stop();
  rejectRead?.(new HomeRegistryTimeoutError(5_000));
  await Promise.all([polling, stopping]);

  assert.deepEqual(invalidations, []);
});

test("desktop backs off non-timeout registry errors and disables stale services", async () => {
  const snapshots: DesktopSnapshot[] = [];
  let generation = 1;
  let now = 0;
  let reads = 0;
  const runtime = await startDesktopRuntime(
    {
      subscriber: {
        stateDir: "/state/subscriber",
        gatewayPort: 17_480,
        services: [{ id: "ssh", localPort: 2222 }],
      },
      onSnapshot: (snapshot) => snapshots.push(snapshot),
    },
    dependencies([], {
      startSubscriber: async () =>
        runningSubscriber(
          () => subscriberStatus("connected", generation),
          [],
        ),
      readRegistry: async () => {
        reads++;
        if (reads === 1) return registry;
        throw new Error("Home registry returned HTTP 503");
      },
      now: () => now,
      random: () => 0.5,
    } as Partial<DesktopRuntimeDependencies>),
  );

  generation = 2;
  await runtime.poll();
  assert.deepEqual(
    snapshots.at(-1)?.subscriber?.services.map(({ available }) => available),
    [false, false],
  );
  assert.equal(reads, 2);

  await runtime.poll();
  assert.equal(reads, 2);
  now = 1_000;
  await runtime.poll();
  assert.equal(reads, 3);

  for (const expectedAt of [3_000, 7_000, 15_000, 31_000, 61_000, 91_000]) {
    now = expectedAt - 1;
    await runtime.poll();
    const readsBeforeDeadline: number = reads;
    now = expectedAt;
    await runtime.poll();
    assert.equal(reads, readsBeforeDeadline + 1);
  }
  await runtime.stop();
});

test("desktop runtime starts both roles concurrently and polls publisher counters", async () => {
  const events: string[] = [];
  const snapshots: DesktopSnapshot[] = [];
  let releasePublisher: (() => void) | undefined;
  let releaseSubscriber: (() => void) | undefined;
  let publisherStatusValue = publisherStatus(0, 0);
  const startTask = startDesktopRuntime(
    {
      publisher: { stateDir: "/state/publisher" },
      subscriber: {
        stateDir: "/state/subscriber",
        gatewayPort: 17_480,
        services: [],
      },
      onSnapshot: (snapshot) => snapshots.push(snapshot),
    },
    dependencies(events, {
      startPublisher: async () => {
        events.push("publisher:start");
        await new Promise<void>((resolve) => {
          releasePublisher = resolve;
        });
        return runningPublisher(() => publisherStatusValue, events);
      },
      startSubscriber: async () => {
        events.push("subscriber:start");
        await new Promise<void>((resolve) => {
          releaseSubscriber = resolve;
        });
        return runningSubscriber(
          () => subscriberStatus("connected", 1),
          events,
        );
      },
    }),
  );

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(events.includes("publisher:start"), true);
  assert.equal(events.includes("subscriber:start"), true);
  releasePublisher?.();
  releaseSubscriber?.();
  const runtime = await startTask;

  publisherStatusValue = publisherStatus(3, 5);
  await runtime.poll();
  assert.equal(snapshots.at(-1)?.publisher?.activeSubscribers, 3);
  assert.equal(snapshots.at(-1)?.publisher?.acceptedConnections, 5);
  assert.equal(snapshots.at(-1)?.subscriber?.connection, "connected");

  await runtime.stop();
  assert.ok(
    events.indexOf("publisher:stop") < events.indexOf("subscriber:stop"),
  );
});

test("desktop runtime exposes publisher pairing invitation and approval actions", async () => {
  const events: string[] = [];
  const snapshots: DesktopSnapshot[] = [];
  let status = publisherStatus(0, 0);
  const runtime = await startDesktopRuntime(
    {
      publisher: { stateDir: "/state/publisher" },
      onSnapshot: (snapshot) => snapshots.push(snapshot),
    },
    dependencies(events, {
      startPublisher: async () => ({
        ...runningPublisher(() => status, events),
        createPairingInvitation: () => {
          events.push("pairing:create");
          status = {
            ...status,
            pairing: {
              phase: "inviting",
              expiresAt: 1_750_000_120_000,
              expired: false,
            },
          };
          return {
            uri: "kepos://pair?v=1&token=secret",
            expiresAt: 1_750_000_120_000,
          };
        },
        approvePairing: async () => {
          events.push("pairing:approve");
          status = { ...status, pairing: { phase: "idle" } };
        },
      }),
    }),
  );

  await runtime.createPairingInvitation();
  assert.equal(events.includes("pairing:create"), true);
  assert.deepEqual(snapshots.at(-1)?.publisher?.pairing, {
    phase: "inviting",
    expiresAt: 1_750_000_120_000,
    expired: false,
    qrSvg: "<svg>pairing</svg>",
  });
  assert.equal(
    JSON.stringify(snapshots.at(-1)).includes("token=secret"),
    false,
  );

  status = {
    ...status,
    pairing: {
      phase: "pending",
      subscriberKey: "cd".repeat(32),
      keyFingerprint: "cd".repeat(8),
      label: "Neil's Pixel",
      platform: "android",
    },
  };
  await runtime.poll();
  assert.equal(snapshots.at(-1)?.publisher?.pairing?.phase, "pending");
  await runtime.approvePairing();
  assert.equal(events.includes("pairing:approve"), true);
  assert.equal(snapshots.at(-1)?.publisher?.pairing, undefined);

  await runtime.stop();
});

test("desktop keeps a failed approval pending and exposes its error", async () => {
  const snapshots: DesktopSnapshot[] = [];
  const status = {
    ...publisherStatus(0, 0),
    pairing: {
      phase: "pending" as const,
      subscriberKey: "cd".repeat(32),
      keyFingerprint: "cd".repeat(8),
      label: "Neil's Pixel",
      platform: "android",
    },
  };
  const runtime = await startDesktopRuntime(
    {
      publisher: { stateDir: "/state/publisher" },
      onSnapshot: (snapshot) => snapshots.push(snapshot),
    },
    dependencies([], {
      startPublisher: async () => ({
        ...runningPublisher(() => status, []),
        approvePairing: async () => {
          throw new Error("Cannot save publisher allowlist");
        },
      }),
    }),
  );

  await assert.rejects(runtime.approvePairing(), /Cannot save/);
  assert.deepEqual(snapshots.at(-1)?.publisher?.pairing, {
    ...status.pairing,
    error: "Cannot save publisher allowlist",
  });

  await runtime.stop();
});

test("desktop runtime applies shared network and role policy", async () => {
  const events: string[] = [];
  let publisherStartOptions: Record<string, unknown> | undefined;
  let subscriberStartOptions: Record<string, unknown> | undefined;
  const persisted: Array<{ configPath: string; allow: string[] }> = [];
  const bootstrap = [{ host: "bootstrap.example", port: 49_737 }];
  const publisherPolicy = {
    displayName: "Configured publisher",
    allow: ["22".repeat(32)],
    services: [{ id: "web", name: "Web", targetPort: 8_080 }],
  };
  const runtime = await startDesktopRuntime(
    {
      publisher: {
        stateDir: "/state/publisher",
        configPath: "/config/kepos.toml",
        bootstrap,
        policy: publisherPolicy,
      },
      subscriber: {
        stateDir: "/state/subscriber",
        gatewayPort: 17_480,
        bootstrap,
        route: "public",
        services: [],
      },
      onSnapshot: () => undefined,
    },
    dependencies(events, {
      startPublisher: async (options) => {
        publisherStartOptions = options as unknown as Record<string, unknown>;
        return runningPublisher(() => publisherStatus(0, 0), events);
      },
      startSubscriber: async (options) => {
        subscriberStartOptions = options as unknown as Record<string, unknown>;
        return runningSubscriber(
          () => subscriberStatus("connected", 1),
          events,
        );
      },
      persistPublisherAllowlist: async (configPath, allow) => {
        persisted.push({ configPath, allow });
      },
    }),
  );

  assert.deepEqual(publisherStartOptions?.bootstrap, bootstrap);
  assert.deepEqual(publisherStartOptions?.policy, publisherPolicy);
  await (
    publisherStartOptions?.persistAllowlist as (allow: string[]) => Promise<void>
  )(["33".repeat(32)]);
  assert.deepEqual(persisted, [
    { configPath: "/config/kepos.toml", allow: ["33".repeat(32)] },
  ]);
  assert.deepEqual(subscriberStartOptions?.bootstrap, bootstrap);
  assert.equal(subscriberStartOptions?.route, "public");
  await runtime.stop();
});

test("desktop runtime reconfigures only the changed role", async () => {
  const events: string[] = [];
  const subscriber = {
    stateDir: "/state/subscriber",
    gatewayPort: 17_480,
    services: [{ id: "ssh", localPort: 2_222 }],
  };
  const publisher = {
    stateDir: "/state/publisher",
    policy: {
      displayName: "Before",
      allow: [],
      services: [],
    },
  };
  const runtime = await startDesktopRuntime(
    {
      publisher,
      subscriber,
      onSnapshot: () => undefined,
    },
    dependencies(events),
  );
  const before = events.length;
  const configurable = runtime as typeof runtime & {
    reconfigure(options: {
      publisher?: typeof publisher;
      subscriber?: typeof subscriber;
    }): Promise<void>;
  };

  await configurable.reconfigure({
    publisher: {
      ...publisher,
      policy: { ...publisher.policy, displayName: "After" },
    },
    subscriber,
  });

  assert.deepEqual(events.slice(before), [
    "publisher:stop",
    "publisher-lock:release",
    "publisher-lock:acquire:/state/publisher",
    "publisher-state:load:/state/publisher",
    "publisher:start:/state/publisher",
  ]);
  assert.equal(events.slice(before).includes("subscriber:stop"), false);
  await runtime.stop();
});

test("desktop reconfiguration attempts both role cleanups after one fails", async () => {
  const events: string[] = [];
  const runtime = await startDesktopRuntime(
    {
      publisher: { stateDir: "/state/publisher" },
      subscriber: {
        stateDir: "/state/subscriber",
        gatewayPort: 17_480,
        services: [],
      },
      onSnapshot: () => undefined,
    },
    dependencies(events, {
      startPublisher: async () => ({
        ...runningPublisher(() => publisherStatus(0, 0), events),
        stop: async () => {
          events.push("publisher:stop");
          throw new Error("publisher stop failed");
        },
      }),
    }),
  );

  await assert.rejects(runtime.reconfigure({}), /publisher stop failed/);
  assert.equal(events.includes("publisher-lock:release"), true);
  assert.equal(events.includes("subscriber:stop"), true);
  assert.equal(events.includes("subscriber-lock:release"), true);
  await runtime.stop().catch(() => undefined);
});

test("desktop runtime isolates publisher startup failure from subscriber", async () => {
  const events: string[] = [];
  const snapshots: DesktopSnapshot[] = [];
  const runtime = await startDesktopRuntime(
    {
      publisher: { stateDir: "/state/publisher" },
      subscriber: {
        stateDir: "/state/subscriber",
        gatewayPort: 17_480,
        services: [],
      },
      onSnapshot: (snapshot) => snapshots.push(snapshot),
    },
    dependencies(events, {
      startPublisher: async () => {
        throw new Error("publisher unavailable");
      },
    }),
  );

  assert.equal(snapshots.at(-1)?.appPhase, "running");
  assert.deepEqual(snapshots.at(-1)?.publisher, {
    phase: "failed",
    displayName: "Mac smoke",
    publisherKey: localPublisherKey,
    keyFingerprint: localPublisherKey.slice(0, 16),
    activeSubscribers: 0,
    acceptedConnections: 0,
    services: [{ id: "smoke", name: "Smoke", targetPort: 18_080 }],
    error: "publisher unavailable",
  });
  assert.equal(snapshots.at(-1)?.subscriber?.phase, "running");
  assert.deepEqual(events.filter((event) => event.includes("publisher-lock")), [
    "publisher-lock:acquire:/state/publisher",
    "publisher-lock:release",
  ]);
  await runtime.stop();
});

test("desktop runtime isolates subscriber startup failure from publisher", async () => {
  const events: string[] = [];
  const snapshots: DesktopSnapshot[] = [];
  const runtime = await startDesktopRuntime(
    {
      publisher: { stateDir: "/state/publisher" },
      subscriber: {
        stateDir: "/state/subscriber",
        gatewayPort: 17_480,
        services: [],
      },
      onSnapshot: (snapshot) => snapshots.push(snapshot),
    },
    dependencies(events, {
      startSubscriber: async () => {
        throw new Error("subscriber unavailable");
      },
    }),
  );

  assert.equal(snapshots.at(-1)?.publisher?.phase, "running");
  assert.deepEqual(snapshots.at(-1)?.subscriber, {
    phase: "failed",
    connection: "stopped",
    services: [],
    error: "subscriber unavailable",
  });
  assert.deepEqual(events.filter((event) => event.includes("subscriber-lock")), [
    "subscriber-lock:acquire:/state/subscriber",
    "subscriber-lock:release",
  ]);
  await runtime.stop();
});

test("desktop runtime stops live roles before releasing locks after status failure", async () => {
  const events: string[] = [];
  const snapshots: DesktopSnapshot[] = [];
  const runtime = await startDesktopRuntime(
    {
      publisher: { stateDir: "/state/publisher" },
      subscriber: {
        stateDir: "/state/subscriber",
        gatewayPort: 17_480,
        services: [],
      },
      onSnapshot: (snapshot) => snapshots.push(snapshot),
    },
    dependencies(events, {
      startPublisher: async () =>
        runningPublisher(() => {
          throw new Error("publisher status failed");
        }, events),
      startSubscriber: async () =>
        runningSubscriber(() => {
          throw new Error("subscriber status failed");
        }, events),
    }),
  );

  assert.equal(events.includes("publisher:stop"), true);
  assert.equal(events.includes("subscriber:stop"), true);
  assert.ok(
    events.indexOf("publisher:stop") <
      events.indexOf("publisher-lock:release"),
  );
  assert.ok(
    events.indexOf("subscriber:stop") <
      events.indexOf("subscriber-lock:release"),
  );
  assert.equal(snapshots.at(-1)?.publisher?.phase, "failed");
  assert.equal(snapshots.at(-1)?.subscriber?.phase, "failed");
  await runtime.stop();
});

test("desktop reconfiguration rejects when a replacement role cannot start", async () => {
  const events: string[] = [];
  const snapshots: DesktopSnapshot[] = [];
  let starts = 0;
  const publisher = {
    stateDir: "/state/publisher",
    policy: {
      displayName: "Before",
      allow: [],
      services: [],
    },
  };
  const runtime = await startDesktopRuntime(
    {
      publisher,
      onSnapshot: (snapshot) => snapshots.push(snapshot),
    },
    dependencies(events, {
      startPublisher: async () => {
        starts++;
        if (starts === 2) throw new Error("replacement unavailable");
        return runningPublisher(() => publisherStatus(0, 0), events);
      },
    }),
  );

  await assert.rejects(
    runtime.reconfigure({
      publisher: {
        ...publisher,
        policy: { ...publisher.policy, displayName: "After" },
      },
    }),
    /replacement unavailable/,
  );
  assert.equal(snapshots.at(-1)?.publisher?.phase, "failed");
  assert.equal(events.at(-1), "publisher-lock:release");
  await runtime.stop();
});

test("desktop runtime coalesces overlapping polls and suppresses late snapshots", async () => {
  const snapshots: DesktopSnapshot[] = [];
  let generation = 1;
  let registryReads = 0;
  let resolveRegistry: ((value: HomeRegistry) => void) | undefined;
  const runtime = await startDesktopRuntime(
    {
      subscriber: {
        stateDir: "/state/subscriber",
        gatewayPort: 17_480,
        services: [],
      },
      onSnapshot: (snapshot) => snapshots.push(snapshot),
    },
    dependencies([], {
      startSubscriber: async () =>
        runningSubscriber(
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
    }),
  );

  generation = 2;
  const first = runtime.poll();
  const second = runtime.poll();
  assert.equal(first, second);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(registryReads, 2);

  await runtime.stop();
  resolveRegistry?.(registry);
  await first;
  assert.equal(snapshots.at(-1)?.appPhase, "stopped");
});

test("desktop runtime attempts every cleanup step and preserves first failure", async () => {
  const events: string[] = [];
  const runtime = await startDesktopRuntime(
    {
      publisher: { stateDir: "/state/publisher" },
      subscriber: {
        stateDir: "/state/subscriber",
        gatewayPort: 17_480,
        services: [],
      },
      onSnapshot: () => {},
    },
    dependencies(events, {
      startPublisher: async () => ({
        ...runningPublisher(() => publisherStatus(0, 0), events),
        stop: async () => {
          events.push("publisher:stop");
          throw new Error("publisher stop failed");
        },
      }),
    }),
  );

  await assert.rejects(runtime.stop(), /publisher stop failed/);
  assert.equal(events.includes("publisher-lock:release"), true);
  assert.equal(events.includes("subscriber:stop"), true);
  assert.equal(events.includes("subscriber-lock:release"), true);
});

test("desktop runtime cleans every role when the stopping snapshot fails", async () => {
  const events: string[] = [];
  const runtime = await startDesktopRuntime(
    {
      publisher: { stateDir: "/state/publisher" },
      subscriber: {
        stateDir: "/state/subscriber",
        gatewayPort: 17_480,
        services: [],
      },
      onSnapshot: (snapshot) => {
        if (snapshot.appPhase === "stopping") {
          throw new Error("stopping snapshot failed");
        }
      },
    },
    dependencies(events),
  );

  await assert.rejects(runtime.stop(), /stopping snapshot failed/);
  assert.equal(events.includes("publisher:stop"), true);
  assert.equal(events.includes("publisher-lock:release"), true);
  assert.equal(events.includes("subscriber:stop"), true);
  assert.equal(events.includes("subscriber-lock:release"), true);
});

function dependencies(
  events: string[],
  overrides: Partial<DesktopRuntimeDependencies> = {},
): DesktopRuntimeDependencies {
  return {
    acquirePublisherLock: async (stateDir) => {
      events.push(`publisher-lock:acquire:${stateDir}`);
      return {
        release: async () => {
          events.push("publisher-lock:release");
        },
      };
    },
    acquireSubscriberLock: async (stateDir) => {
      events.push(`subscriber-lock:acquire:${stateDir}`);
      return {
        release: async () => {
          events.push("subscriber-lock:release");
        },
      };
    },
    loadPublisherState: async (stateDir) => {
      events.push(`publisher-state:load:${stateDir}`);
      return {
        config: { seed: localPublisherSeed, allow: ["22".repeat(32)] },
        manifest: {
          displayName: "Mac smoke",
          publisherConfig: "publisher.json",
          services: [
            { id: "smoke", name: "Smoke", kind: "tcp", targetPort: 18_080 },
          ],
        },
      };
    },
    startPublisher: async (options) => {
      events.push(`publisher:start:${options.stateDir}`);
      return runningPublisher(() => publisherStatus(1, 2), events);
    },
    startSubscriber: async (options) => {
      events.push(`subscriber:start:${options.stateDir}`);
      return runningSubscriber(
        () => subscriberStatus("connected", 1),
        events,
      );
    },
    readRegistry: async () => registry,
    now: Date.now,
    random: () => 0.5,
    renderPairingQr: async () => "<svg>pairing</svg>",
    persistPublisherAllowlist: async () => undefined,
    ...overrides,
  };
}

function subscriberStatus(
  connection: SubscriberRuntimeStatus["connection"],
  connectionGeneration = connection === "connected" ? 1 : 0,
  services: SubscriberRuntimeStatus["services"] = [
    { id: "ssh", port: 2222 },
  ],
): SubscriberRuntimeStatus {
  return {
    role: "subscriber",
    state: connection === "stopped" ? "stopped" : "running",
    connection,
    connectionGeneration,
    publisherKey: remotePublisherKey,
    homeUrl: "http://home.localhost:17480",
    services,
  };
}

function runningSubscriber(
  status: () => SubscriberRuntimeStatus,
  events: string[],
  invalidateConnection: RunningSubscriber["invalidateConnection"] = (
    generation,
    reason,
  ) => {
    events.push(`subscriber:invalidate:${generation}:${reason}`);
    return true;
  },
): RunningSubscriber {
  return {
    publisherKey: remotePublisherKey,
    home: { port: 17_480, url: "http://home.localhost:17480" },
    services: [{ id: "ssh", port: 2222 }],
    invalidateConnection,
    status,
    stop: async () => {
      events.push("subscriber:stop");
    },
  };
}

function publisherStatus(
  activeSubscribers: number,
  acceptedConnections: number,
): PublisherRuntimeStatus {
  return {
    role: "publisher",
    state: "running",
    publisherKey: localPublisherKey,
    homeUrl: "http://127.0.0.1:3000",
    activeSubscribers,
    acceptedConnections,
    pairing: { phase: "idle" },
  };
}

function runningPublisher(
  status: () => PublisherRuntimeStatus,
  events: string[],
): RunningPublisher {
  return {
    publisherKey: localPublisherKey,
    home: {
      host: "127.0.0.1",
      port: 3000,
      url: "http://127.0.0.1:3000",
      close: async () => {},
    },
    acceptedConnections: () => status().acceptedConnections,
    activeSubscribers: () => status().activeSubscribers,
    approvePairing: async () => undefined,
    cancelPairing: () => undefined,
    createPairingInvitation: () => ({ uri: "kepos://pair", expiresAt: 0 }),
    denyPairing: () => undefined,
    pairingStatus: () => ({ phase: "idle" }),
    status,
    stop: async () => {
      events.push("publisher:stop");
    },
  };
}
