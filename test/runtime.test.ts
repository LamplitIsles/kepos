import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  createDefaultCliDependencies,
  runCli,
} from "../src/cli/main.js";
import {
  createDht,
  type DhtNode,
} from "../src/mux/hyperdht.js";
import type { Observation } from "../src/mux/observability.js";
import { startMetricsServer } from "../src/metrics/server.js";
import {
  startPublisher,
  type PublisherRuntimePolicy,
  type PublisherRuntimeStatus,
} from "../src/runtime/publisher.js";
import {
  startSubscriber,
  type SubscriberRuntimeStatus,
} from "../src/runtime/subscriber.js";
import { setupPublisher } from "../src/state/publisher.js";
import {
  setSubscriberPublisher,
  setupSubscriber,
} from "../src/state/subscriber.js";

interface HyperDhtTestnet {
  bootstrap: Array<{ host: string; port: number }>;
  destroy: () => Promise<void>;
}

type CreateHyperDhtTestnet = (size: number) => Promise<HyperDhtTestnet>;

const require = createRequire(import.meta.url);
const createHyperDhtTestnet = require(
  "hyperdht/testnet",
) as CreateHyperDhtTestnet;

const emptyPublisherPolicy: PublisherRuntimePolicy = {
  displayName: "publisher",
  subscribers: [],
  services: [],
};

function subscriberDevices(
  keys: readonly string[],
): Array<{ publicKey: string; label: string }> {
  return keys.map((publicKey, index) => ({
    publicKey,
    label: `subscriber-${index + 1}`,
  }));
}

function trackDht(node: DhtNode): {
  calls: { connect: number; createServer: number; destroy: number };
  node: DhtNode;
} {
  const calls = { connect: 0, createServer: 0, destroy: 0 };
  return {
    calls,
    node: {
      connect: (...arguments_) => {
        calls.connect++;
        return node.connect(...arguments_);
      },
      createServer: (...arguments_) => {
        calls.createServer++;
        return node.createServer(...arguments_);
      },
      stats: node.stats,
      destroy: async (...arguments_) => {
        calls.destroy++;
        await node.destroy(...arguments_);
      },
    },
  };
}

test("borrowed DHT rejects role-level bootstrap before loading state", async () => {
  const dht = createDht({});
  const options = {
    stateDir: path.join(tmpdir(), "kepos-missing-borrowed-state"),
    bootstrap: [{ host: "bootstrap.example", port: 49_737 }],
    dht,
    policy: emptyPublisherPolicy,
  };

  try {
    await assert.rejects(
      startPublisher(options),
      /publisher dht and bootstrap are mutually exclusive/,
    );
    await assert.rejects(
      startSubscriber({ ...options, services: [] }),
      /subscriber dht and bootstrap are mutually exclusive/,
    );
  } finally {
    await dht.destroy({ force: true });
  }
});

test("publisher stop reports cleanup failure after closing its Home server", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kepos-publisher-stop-"));
  const stateDir = path.join(root, "publisher");
  await setupPublisher({ stateDir });
  let serverCloseAttempts = 0;
  const dht = {
    stats: {
      punches: { consistent: 0, random: 0, open: 0 },
      relaying: { attempts: 0, successes: 0, aborts: 0 },
    },
    connect: () => {
      throw new Error("unexpected connect");
    },
    createServer: () => ({
      listen: async () => undefined,
      close: async () => {
        serverCloseAttempts++;
        throw new Error("publisher server close failed");
      },
    }),
    destroy: async () => undefined,
  } as DhtNode;
  const publisher = await startPublisher({ stateDir, dht, policy: emptyPublisherPolicy });

  try {
    await assert.rejects(publisher.stop(), /publisher server close failed/);
    assert.equal(serverCloseAttempts, 1);
    await assert.rejects(fetch(`${publisher.home.url}/healthz`));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("publisher runtime serves metrics on a loopback port and closes it on stop", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kepos-publisher-metrics-"));
  const stateDir = path.join(root, "publisher");
  await setupPublisher({ stateDir });
  const dht = {
    stats: {
      punches: { consistent: 0, random: 0, open: 0 },
      relaying: { attempts: 0, successes: 0, aborts: 0 },
    },
    connect: () => {
      throw new Error("unexpected connect");
    },
    createServer: () => ({
      listen: async () => undefined,
      close: async () => undefined,
    }),
    destroy: async () => undefined,
  } as DhtNode;
  const publisher = await startPublisher({
    stateDir,
    dht,
    policy: emptyPublisherPolicy,
    metricsListen: { host: "127.0.0.1", port: 0 },
  });

  try {
    assert.ok(publisher.metrics);
    const response = await fetch(publisher.metrics.url);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /kepos_publisher_subscriber_connected/);
    await publisher.stop();
    await assert.rejects(() => fetch(publisher.metrics!.url));
  } finally {
    await publisher.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("publisher metrics bind failure closes the started publisher/DHT server", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kepos-publisher-metrics-bind-"));
  const stateDir = path.join(root, "publisher");
  await setupPublisher({ stateDir });
  const blocker = await startMetricsServer({
    listen: { host: "127.0.0.1", port: 0 },
    render: () => "# TYPE kepos_blocker gauge\nkepos_blocker 1\n",
  });
  let serverCloseCalls = 0;
  const dht = {
    stats: {
      punches: { consistent: 0, random: 0, open: 0 },
      relaying: { attempts: 0, successes: 0, aborts: 0 },
    },
    connect: () => {
      throw new Error("unexpected connect");
    },
    createServer: () => ({
      listen: async () => undefined,
      close: async () => {
        serverCloseCalls++;
      },
    }),
    destroy: async () => undefined,
  } as DhtNode;

  try {
    await assert.rejects(
      startPublisher({
        stateDir,
        dht,
        policy: emptyPublisherPolicy,
        metricsListen: { host: "127.0.0.1", port: blocker.port },
      }),
      /EADDRINUSE|address already in use/i,
    );
    assert.equal(serverCloseCalls, 1);
    await blocker.close();
    await assert.rejects(() => fetch(blocker.url));
  } finally {
    await blocker.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("subscriber stop closes its gateway after connection cleanup fails", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kepos-subscriber-stop-"));
  const stateDir = path.join(root, "subscriber");
  await setupSubscriber({ stateDir });
  await setSubscriberPublisher({
    stateDir,
    label: "cleanup",
    publisherKey: "ab".repeat(32),
  });
  const dht = {
    stats: {
      punches: { consistent: 0, random: 0, open: 0 },
      relaying: { attempts: 0, successes: 0, aborts: 0 },
    },
    connect: () => {
      throw new Error("unexpected connect");
    },
    createServer: () => {
      throw new Error("unexpected server");
    },
    destroy: async () => undefined,
  } as DhtNode;
  const subscriber = await startSubscriber(
    {
      stateDir,
      dht,
      gatewayPort: 0,
      services: [],
      waitForPublisher: false,
    },
    {
      createPublisherConnection: () => ({
        start: async () => undefined,
        startInBackground: () => undefined,
        generation: () => 1,
        invalidate: () => false,
        status: () => "connected",
        open: async () => {
          throw new Error("unexpected open");
        },
        stop: async () => {
          throw new Error("subscriber connection stop failed");
        },
      }),
    },
  );

  try {
    await assert.rejects(
      subscriber.stop(),
      /subscriber connection stop failed/,
    );
    await assert.rejects(fetch(`${subscriber.home.url}/healthz`));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dual-role runtimes borrow one DHT without merging role identities", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kepos-runtime-shared-dht-"));
  const devicePublisherState = path.join(root, "device-publisher");
  const deviceSubscriberState = path.join(root, "device-subscriber");
  const remotePublisherState = path.join(root, "remote-publisher");
  const remoteSubscriberState = path.join(root, "remote-subscriber");
  const deviceSubscriberIdentity = await setupSubscriber({
    stateDir: deviceSubscriberState,
  });
  const remoteSubscriberIdentity = await setupSubscriber({
    stateDir: remoteSubscriberState,
  });
  const devicePublisherIdentity = await setupPublisher({ stateDir: devicePublisherState });
  const remotePublisherIdentity = await setupPublisher({ stateDir: remotePublisherState });
  const devicePublisherPolicy: PublisherRuntimePolicy = {
    displayName: "device",
    subscribers: subscriberDevices([remoteSubscriberIdentity.publicKey]),
    services: [],
  };
  const remotePublisherPolicy: PublisherRuntimePolicy = {
    displayName: "remote",
    subscribers: subscriberDevices([deviceSubscriberIdentity.publicKey]),
    services: [],
  };
  await Promise.all([
    setSubscriberPublisher({
      stateDir: deviceSubscriberState,
      label: "remote",
      publisherKey: remotePublisherIdentity.publisherKey,
    }),
    setSubscriberPublisher({
      stateDir: remoteSubscriberState,
      label: "device",
      publisherKey: devicePublisherIdentity.publisherKey,
    }),
  ]);
  const testnet = await createHyperDhtTestnet(3);
  const sharedDht = createDht({ bootstrap: testnet.bootstrap });
  const tracked = trackDht(sharedDht);
  let devicePublisher: Awaited<ReturnType<typeof startPublisher>> | undefined;
  let deviceSubscriber: Awaited<ReturnType<typeof startSubscriber>> | undefined;
  let remotePublisher: Awaited<ReturnType<typeof startPublisher>> | undefined;
  let remoteSubscriber: Awaited<ReturnType<typeof startSubscriber>> | undefined;

  try {
    [devicePublisher, remotePublisher] = await Promise.all([
      startPublisher({
        stateDir: devicePublisherState,
        dht: tracked.node,
        policy: devicePublisherPolicy,
      }),
      startPublisher({
        stateDir: remotePublisherState,
        bootstrap: testnet.bootstrap,
        policy: remotePublisherPolicy,
      }),
    ]);
    [deviceSubscriber, remoteSubscriber] = await Promise.all([
      startSubscriber({
        stateDir: deviceSubscriberState,
        dht: tracked.node,
        gatewayPort: 0,
        services: [],
      }),
      startSubscriber({
        stateDir: remoteSubscriberState,
        bootstrap: testnet.bootstrap,
        gatewayPort: 0,
        services: [],
      }),
    ]);

    assert.notEqual(
      devicePublisherIdentity.publisherKey,
      deviceSubscriberIdentity.publicKey,
    );
    assert.deepEqual(tracked.calls, {
      connect: 1,
      createServer: 1,
      destroy: 0,
    });
    assert.equal(devicePublisher.activeSubscribers(), 1);
    assert.equal(remotePublisher.activeSubscribers(), 1);

    await deviceSubscriber.stop();
    assert.equal(tracked.calls.destroy, 0);
    assert.equal(
      (await fetch(`${remoteSubscriber.home.url}/healthz`)).status,
      200,
    );

    deviceSubscriber = await startSubscriber({
      stateDir: deviceSubscriberState,
      dht: tracked.node,
      gatewayPort: 0,
      services: [],
    });
    await devicePublisher.stop();
    assert.equal(tracked.calls.destroy, 0);
    assert.equal(
      (await fetch(`${deviceSubscriber.home.url}/healthz`)).status,
      200,
    );
  } finally {
    await Promise.allSettled([
      deviceSubscriber?.stop(),
      devicePublisher?.stop(),
      remoteSubscriber?.stop(),
      remotePublisher?.stop(),
    ]);
    await Promise.allSettled([
      sharedDht.destroy({ force: true }),
      testnet.destroy(),
      rm(root, { recursive: true, force: true }),
    ]);
  }
});

test("publisher and subscriber expose synchronous status around an awaited lifecycle", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kepos-runtime-"));
  const publisherState = path.join(root, "publisher");
  const subscriberState = path.join(root, "subscriber");
  const output: string[] = [];
  const subscriberEvents: Observation[] = [];
  const cli = {
    ...createDefaultCliDependencies({
      stdout: (line) => output.push(line),
      stderr: (line) => output.push(line),
    }),
    loadConfig: async () => undefined,
  };
  await runCli(
    ["setup", "subscriber", "--state", subscriberState],
    cli,
  );
  const subscriberKey = output.at(-1)?.split(": ")[1];
  assert.ok(subscriberKey);
  assert.match(subscriberKey, /^[0-9a-f]{64}$/);
  await runCli(
    [
      "setup",
      "publisher",
      "--state",
      publisherState,
    ],
    cli,
  );
  const publisherKey = output.at(-1)?.split(": ")[1];
  assert.ok(publisherKey);
  assert.match(publisherKey, /^[0-9a-f]{64}$/);
  await runCli(
    [
      "subscriber",
      "set-publisher",
      "--state",
      subscriberState,
      "--label",
      "kosmos",
      "--publisher-key",
      publisherKey,
    ],
    cli,
  );
  const testnet = await createHyperDhtTestnet(3);
  let publisher:
    | Awaited<ReturnType<typeof startPublisher>>
    | undefined;
  let subscriber:
    | Awaited<ReturnType<typeof startSubscriber>>
    | undefined;

  try {
    publisher = await startPublisher({
      stateDir: publisherState,
      bootstrap: testnet.bootstrap,
      policy: {
        displayName: "kosmos",
        subscribers: [{ label: "kosmos", publicKey: subscriberKey }],
        services: [],
      },
    });
    assert.deepEqual(publisher.status(), {
      role: "publisher",
      state: "running",
      publisherKey,
      homeUrl: publisher.home.url,
      acceptedConnections: 0,
      activeSubscribers: 0,
      activeSubscriberKeys: [],
      pairing: { phase: "idle" },
    } satisfies PublisherRuntimeStatus);

    subscriber = await startSubscriber({
      stateDir: subscriberState,
      bootstrap: testnet.bootstrap,
      gatewayPort: 0,
      observe: (event) => subscriberEvents.push(event),
      services: [],
    });
    assert.deepEqual(subscriber.status(), {
      role: "subscriber",
      state: "running",
      connection: "connected",
      connectionGeneration: 1,
      publisherKey,
      publisherLabel: "kosmos",
      subscriberKey,
      homeUrl: subscriber.home.url,
      services: [],
    } satisfies SubscriberRuntimeStatus);
    assert.equal((await fetch(`${subscriber.home.url}/healthz`)).status, 200);
    assert.equal(publisher.status().activeSubscribers, 1);
    assert.deepEqual(publisher.status().activeSubscriberKeys, [subscriberKey]);

    const connected = subscriberEvents.find(
      ({ event }) => event === "outer.connected",
    );
    assert.ok(connected);
    const transport = connected.transport as Record<string, unknown>;
    assert.equal(typeof transport.udx, "object");
    assert.doesNotMatch(
      JSON.stringify(connected),
      /(?:127\.0\.0\.1|0\.0\.0\.0|::1)/u,
    );

    await subscriber.stop();
    assert.equal(subscriber.status().state, "stopped");
    await publisher.stop();
    assert.equal(publisher.status().state, "stopped");
  } finally {
    await Promise.allSettled([
      subscriber?.stop(),
      publisher?.stop(),
      testnet.destroy(),
      rm(root, { recursive: true, force: true }),
    ]);
  }
});

test("publisher runtime rejects state that the shared state loader rejects", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kepos-runtime-state-"));
  const stateDir = path.join(root, "publisher");
  await setupPublisher({ stateDir });
  await writeFile(path.join(stateDir, "unexpected.json"), "{}");
  const testnet = await createHyperDhtTestnet(3);
  let publisher:
    | Awaited<ReturnType<typeof startPublisher>>
    | undefined;

  try {
    await assert.rejects(async () => {
      publisher = await startPublisher({
        stateDir,
        bootstrap: testnet.bootstrap,
        policy: emptyPublisherPolicy,
      });
      await publisher.stop();
    }, /partial or invalid state/);
  } finally {
    await Promise.allSettled([
      publisher?.stop(),
      testnet.destroy(),
      rm(root, { recursive: true, force: true }),
    ]);
  }
});

test("publisher runtime uses the explicit policy with identity-only state", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kepos-runtime-policy-"));
  const stateDir = path.join(root, "publisher");
  await setupPublisher({ stateDir });
  const testnet = await createHyperDhtTestnet(3);
  let publisher: Awaited<ReturnType<typeof startPublisher>> | undefined;

  try {
    publisher = await startPublisher({
      stateDir,
      bootstrap: testnet.bootstrap,
      policy: {
        displayName: "kosmos",
        subscribers: [],
        services: [
          { id: "navidrome", name: "Navidrome", targetPort: 4_533 },
        ],
      },
    });
    const registry = (await fetch(
      new URL("/.well-known/kepos/services.json", publisher.home.url),
    ).then((response) => response.json())) as {
      publisher: { displayName: string };
      services: Array<{ id: string }>;
    };
    assert.equal(registry.publisher.displayName, "kosmos");
    assert.deepEqual(
      registry.services.map(({ id }) => id),
      ["home", "navidrome"],
    );
  } finally {
    await Promise.allSettled([
      publisher?.stop(),
      testnet.destroy(),
      rm(root, { recursive: true, force: true }),
    ]);
  }
});

test("subscriber runtime rejects state that the shared state loader rejects", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kepos-runtime-state-"));
  const publisherState = path.join(root, "publisher");
  const subscriberState = path.join(root, "subscriber");
  const subscriber = await setupSubscriber({ stateDir: subscriberState });
  const publisher = await setupPublisher({ stateDir: publisherState });
  const publisherPolicy: PublisherRuntimePolicy = {
    displayName: "kosmos",
    subscribers: subscriberDevices([subscriber.publicKey]),
    services: [],
  };
  await setSubscriberPublisher({
    stateDir: subscriberState,
    label: "kosmos",
    publisherKey: publisher.publisherKey,
  });
  await writeFile(path.join(subscriberState, "unexpected.json"), "{}");
  const testnet = await createHyperDhtTestnet(3);
  let runningPublisher:
    | Awaited<ReturnType<typeof startPublisher>>
    | undefined;
  let runningSubscriber:
    | Awaited<ReturnType<typeof startSubscriber>>
    | undefined;

  try {
    runningPublisher = await startPublisher({
      stateDir: publisherState,
      bootstrap: testnet.bootstrap,
      policy: publisherPolicy,
    });
    await assert.rejects(async () => {
      runningSubscriber = await startSubscriber({
        stateDir: subscriberState,
        bootstrap: testnet.bootstrap,
        gatewayPort: 0,
        services: [],
      });
      await runningSubscriber.stop();
    }, /partial or invalid state/);
  } finally {
    await Promise.allSettled([
      runningSubscriber?.stop(),
      runningPublisher?.stop(),
      testnet.destroy(),
      rm(root, { recursive: true, force: true }),
    ]);
  }
});
