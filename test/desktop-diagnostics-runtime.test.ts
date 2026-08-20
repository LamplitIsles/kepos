import assert from "node:assert/strict";
import { test } from "node:test";

import {
  startDesktopRuntime,
  type DesktopRuntimeDependencies,
} from "../apps/desktop/src/runtime.js";
import type { DesktopSnapshot } from "../apps/desktop/src/protocol.js";
import type { Observation, Observe } from "../src/mux/observability.js";
import type { DhtNode } from "../src/mux/hyperdht.js";
import type {
  PublisherRuntimeStatus,
  RunningPublisher,
} from "../src/runtime/publisher.js";
import type {
  RunningSubscriber,
  SubscriberRuntimeStatus,
} from "../src/runtime/subscriber.js";
import { DEFAULT_GATEWAY_PORT } from "../src/home/gateway.js";
import type { HomeRegistry } from "../src/home/registry.js";

const publisherKey = "aa".repeat(32);
const subscriberKey = "bb".repeat(32);
const remotePublisherKey = "cc".repeat(32);
const timestamp = "2026-08-10T12:00:00.000Z";

const registry: HomeRegistry = {
  schemaVersion: 2,
  revision: 1,
  publisher: { displayName: "Remote", publisherKey: remotePublisherKey },
  services: [{ id: "home", name: "Home", kind: "tcp" }],
};

function dht(): DhtNode {
  return {
    stats: {
      punches: { consistent: 0, random: 0, open: 0 },
      relaying: { attempts: 0, successes: 0, aborts: 0 },
    },
    connect: () => {
      throw new Error("not used");
    },
    createServer: () => {
      throw new Error("not used");
    },
    destroy: async () => undefined,
  } as DhtNode;
}

function observation(
  event: Observation["event"],
  role: Observation["role"],
  outerId: string,
): Observation {
  return {
    component: "kepos",
    timestamp,
    elapsedMs: 0,
    event,
    role,
    outerId,
  };
}

function publisherStatus(): PublisherRuntimeStatus {
  return {
    role: "publisher",
    state: "running",
    publisherKey,
    homeUrl: "http://127.0.0.1:3000",
    acceptedConnections: 1,
    activeSubscribers: 0,
    activeSubscriberKeys: [],
    pairing: { phase: "idle" },
  };
}

function subscriberStatus(
  connection: SubscriberRuntimeStatus["connection"],
): SubscriberRuntimeStatus {
  return {
    role: "subscriber",
    state: "running",
    connection,
    connectionGeneration: 1,
    publisherKey: remotePublisherKey,
    publisherLabel: "Remote",
    subscriberKey,
    homeUrl: "http://home.localhost:17480",
    services: [],
  };
}

function runningPublisher(): RunningPublisher {
  return {
    publisherKey,
    home: {
      host: "127.0.0.1",
      port: 3000,
      url: "http://127.0.0.1:3000",
      close: async () => undefined,
    },
    acceptedConnections: () => 1,
    activeSubscribers: () => 0,
    approvePairing: async () => undefined,
    cancelPairing: () => undefined,
    createPairingInvitation: () => ({ uri: "kepos://pair", expiresAt: 0 }),
    denyPairing: () => undefined,
    pairingStatus: () => ({ phase: "idle" }),
    status: publisherStatus,
    stop: async () => undefined,
  };
}

function runningSubscriber(
  status: () => SubscriberRuntimeStatus,
): RunningSubscriber {
  return {
    publisherKey: remotePublisherKey,
    home: { port: DEFAULT_GATEWAY_PORT, url: "http://home.localhost:17480" },
    services: [],
    invalidateConnection: () => true,
    status,
    stop: async () => undefined,
  };
}

test("desktop runtime forwards both role observations, device events, and correlated failure hints", async () => {
  const observations: Observation[] = [];
  const deviceEvents: Array<Record<string, unknown>> = [];
  const snapshots: DesktopSnapshot[] = [];
  let publisherObserve: Observe | undefined;
  let subscriberObserve: Observe | undefined;
  let persistAllowlist: ((allow: string[]) => Promise<void>) | undefined;
  let subscriberConnection: SubscriberRuntimeStatus["connection"] = "connected";
  const publisher = { stateDir: "/test-owned/publisher", configPath: "/test-owned/config.toml" };
  const subscriber = {
    stateDir: "/test-owned/subscriber",
    gatewayPort: DEFAULT_GATEWAY_PORT,
    services: [],
  };
  const dependencies: DesktopRuntimeDependencies = {
    createDht: dht,
    acquirePublisherLock: async () => ({ release: async () => undefined }),
    acquireSubscriberLock: async () => ({ release: async () => undefined }),
    loadPublisherState: async () => ({
      config: { seed: "11".repeat(32), allow: [] },
      manifest: {
        displayName: "Local",
        publisherConfig: "publisher.json",
        services: [],
      },
    }),
    loadSubscriberConnectionState: async () => ({
      identity: { publicKey: subscriberKey, secretKey: "22".repeat(64) },
      contact: {
        publisherKey: remotePublisherKey,
        label: "Remote",
        requestedLocalPort: 0,
      },
      pending: false,
    }),
    startPublisher: async (options) => {
      publisherObserve = options.observe;
      persistAllowlist = options.persistAllowlist;
      return runningPublisher();
    },
    startSubscriber: async (options) => {
      subscriberObserve = options.observe;
      return runningSubscriber(() => subscriberStatus(subscriberConnection));
    },
    readRegistry: async () => registry,
    now: () => 1_000,
    random: () => 0.5,
    renderPairingQr: async () => "<svg />",
    persistPublisherAllowlist: async () => undefined,
  };
  const runtime = await startDesktopRuntime(
    {
      publisher,
      subscriber,
      onSnapshot: (snapshot) => snapshots.push(snapshot),
      onObservation: (value) => {
        if ("component" in value) observations.push(value);
        else deviceEvents.push(value as unknown as Record<string, unknown>);
      },
    },
    dependencies,
  );

  assert.ok(publisherObserve);
  assert.ok(subscriberObserve);
  publisherObserve?.(observation("outer.accepted", "publisher", "outer-0123456789abcdef"));
  subscriberObserve?.(observation("outer.attempt", "subscriber", "outer-0123456789abcdef"));
  assert.ok(observations.some(({ event }) => event === "outer.accepted"));
  assert.ok(observations.some(({ event }) => event === "outer.attempt"));
  assert.ok(deviceEvents.some((event) => event.event === "desktop.lifecycle"));
  assert.ok(deviceEvents.some((event) => event.event === "desktop.registry"));

  await persistAllowlist?.([]);

  await runtime.reconfigure({ publisher, subscriber });
  assert.ok(deviceEvents.some((event) => event.event === "desktop.config"));

  const failedIds = [
    "outer-0000000000000001",
    "outer-0000000000000002",
    "outer-0000000000000003",
  ];
  for (const outerId of failedIds) {
    subscriberObserve?.(observation("outer.attempt", "subscriber", outerId));
    subscriberObserve?.(observation("outer.closed", "subscriber", outerId));
  }
  assert.equal(
    snapshots.at(-1)?.subscriber?.connectionHint,
    "udp-firewall-vpn-tun",
  );

  // An older overlapping close and a publisher event do not advance the streak.
  subscriberObserve?.(observation("outer.attempt", "subscriber", "outer-0000000000000004"));
  subscriberObserve?.(observation("outer.attempt", "subscriber", "outer-0000000000000005"));
  subscriberObserve?.(observation("outer.closed", "subscriber", "outer-0000000000000004"));
  publisherObserve?.(observation("outer.closed", "publisher", "outer-0000000000000006"));
  assert.equal(
    snapshots.at(-1)?.subscriber?.connectionHint,
    "udp-firewall-vpn-tun",
  );

  subscriberConnection = "connected";
  subscriberObserve?.(observation("outer.connected", "subscriber", "outer-0000000000000005"));
  assert.equal(snapshots.at(-1)?.subscriber?.connectionHint, undefined);
  await runtime.stop();
  assert.ok(deviceEvents.some((event) => event.event === "desktop.lifecycle" && event.phase === "stopped"));
});