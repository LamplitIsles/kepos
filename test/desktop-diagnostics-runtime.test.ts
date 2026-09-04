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
  PublisherRuntimePolicy,
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
const publisherPolicy: PublisherRuntimePolicy = {
  displayName: "Local",
  subscribers: [],
  services: [],
};

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
      updateRegistry: () => undefined,
      close: async () => undefined,
    },
    acceptedConnections: () => 1,
    activeSubscribers: () => 0,
    approvePairing: async () => undefined,
    cancelPairing: () => undefined,
    createPairingInvitation: () => ({ uri: "kepos://pair", expiresAt: 0 }),
    denyPairing: () => undefined,
    pairingStatus: () => ({ phase: "idle" }),
    applyPolicy: async () => false,
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
  let persistSubscribers: ((subscribers: Array<{ label: string; publicKey: string }>) => Promise<void>) | undefined;
  let subscriberConnection: SubscriberRuntimeStatus["connection"] = "connected";
  const publisher = {
    stateDir: "/test-owned/publisher",
    configPath: "/test-owned/config.toml",
    policy: publisherPolicy,
  };
  const subscriber = {
    stateDir: "/test-owned/subscriber",
    gatewayPort: DEFAULT_GATEWAY_PORT,
    services: [],
  };
  const dependencies: DesktopRuntimeDependencies = {
    createDht: dht,
    acquirePublisherLock: async () => ({ release: async () => undefined }),
    acquireSubscriberLock: async () => ({ release: async () => undefined }),
    loadPublisherIdentity: async () => ({ seed: "11".repeat(32) }),
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
      persistSubscribers = options.persistSubscribers;
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
    persistPublisherSubscribers: async () => undefined,
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

  await persistSubscribers?.([]);

  await runtime.reconfigure({ publisher, subscriber });
  assert.ok(deviceEvents.some((event) => event.event === "desktop.config"));

  // The first two attempts overlap. Both matching closes count toward the
  // streak even though the older attempt is no longer the latest one.
  subscriberObserve?.(
    observation("outer.attempt", "subscriber", "outer-0000000000000001"),
  );
  subscriberObserve?.(
    observation("outer.attempt", "subscriber", "outer-0000000000000002"),
  );
  subscriberObserve?.(
    observation("outer.closed", "subscriber", "outer-0000000000000001"),
  );
  subscriberObserve?.(
    observation("outer.closed", "subscriber", "outer-0000000000000002"),
  );
  subscriberObserve?.(
    observation("outer.attempt", "subscriber", "outer-0000000000000003"),
  );
  subscriberObserve?.(
    observation("outer.closed", "subscriber", "outer-0000000000000003"),
  );
  assert.equal(
    snapshots.at(-1)?.subscriber?.connectionHint,
    "udp-firewall-vpn-tun",
  );

  // A publisher event is unrelated. The still-open subscriber attempt can
  // connect and clear the hint even after an older overlapping close.
  subscriberObserve?.(
    observation("outer.attempt", "subscriber", "outer-0000000000000004"),
  );
  subscriberObserve?.(
    observation("outer.attempt", "subscriber", "outer-0000000000000005"),
  );
  subscriberObserve?.(
    observation("outer.closed", "subscriber", "outer-0000000000000004"),
  );
  publisherObserve?.(
    observation("outer.closed", "publisher", "outer-0000000000000006"),
  );
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

test("desktop runtime evicts the oldest subscriber attempt while retaining newer matches", async () => {
  const snapshots: DesktopSnapshot[] = [];
  let subscriberObserve: Observe | undefined;
  const runtime = await startDesktopRuntime(
    {
      subscriber: {
        stateDir: "/test-owned/subscriber",
        gatewayPort: DEFAULT_GATEWAY_PORT,
        services: [],
      },
      onSnapshot: (snapshot) => snapshots.push(snapshot),
      onObservation: () => undefined,
    },
    {
      createDht: dht,
      acquirePublisherLock: async () => ({ release: async () => undefined }),
      acquireSubscriberLock: async () => ({ release: async () => undefined }),
      loadPublisherIdentity: async () => {
        throw new Error("publisher is not configured");
      },
      loadSubscriberConnectionState: async () => ({
        identity: { publicKey: subscriberKey, secretKey: "22".repeat(64) },
        contact: {
          publisherKey: remotePublisherKey,
          label: "Remote",
          requestedLocalPort: 0,
        },
        pending: false,
      }),
      startPublisher: async () => {
        throw new Error("publisher is not configured");
      },
      startSubscriber: async (options) => {
        subscriberObserve = options.observe;
        return runningSubscriber(() => subscriberStatus("connecting"));
      },
      readRegistry: async () => registry,
      now: () => 1_000,
      random: () => 0.5,
      renderPairingQr: async () => "<svg />",
      persistPublisherSubscribers: async () => undefined,
    },
  );

  assert.ok(subscriberObserve);
  const attemptIds = Array.from({ length: 17 }, (_, index) =>
    `outer-${(index + 1).toString(16).padStart(16, "0")}`,
  );
  for (const outerId of attemptIds) {
    subscriberObserve?.(observation("outer.attempt", "subscriber", outerId));
  }

  subscriberObserve?.(
    observation("outer.closed", "subscriber", attemptIds[0]!),
  );
  assert.equal(snapshots.at(-1)?.subscriber?.connectionHint, undefined);
  subscriberObserve?.(
    observation("outer.closed", "subscriber", attemptIds[1]!),
  );
  assert.equal(snapshots.at(-1)?.subscriber?.connectionHint, undefined);
  subscriberObserve?.(
    observation("outer.closed", "subscriber", attemptIds[2]!),
  );
  assert.equal(snapshots.at(-1)?.subscriber?.connectionHint, undefined);
  subscriberObserve?.(
    observation("outer.closed", "subscriber", attemptIds[3]!),
  );
  assert.equal(
    snapshots.at(-1)?.subscriber?.connectionHint,
    "udp-firewall-vpn-tun",
  );

  await runtime.stop();
});
