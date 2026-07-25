import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import {
  createServer as createHttpServer,
  request,
  type Server as HttpServer,
} from "node:http";
import { createConnection, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  startPublisher,
  type RunningPublisher,
} from "../src/runtime/publisher.js";
import {
  startSubscriber,
  type RunningSubscriber,
} from "../src/runtime/subscriber.js";
import {
  loadPublisherState,
  setupPublisher,
} from "../src/state/publisher.js";
import {
  setSubscriberPendingPublisher,
  setSubscriberPublisher,
  setupSubscriber,
} from "../src/state/subscriber.js";
import type { Observation } from "../src/mux/observability.js";
import {
  createDht,
  keyPairFromSecretKey,
  type DhtNode,
  type DhtStream,
} from "../src/mux/hyperdht.js";
import {
  createMuxSubscriber,
  type RunningMuxSubscriber,
} from "../src/mux/transport.js";
import { loadSubscriberState } from "../src/state/subscriber.js";
import { parsePairingInvitation } from "../src/pairing/invitation.js";

interface HyperDhtTestnet {
  bootstrap: Array<{ host: string; port: number }>;
  destroy: () => Promise<void>;
}

type CreateHyperDhtTestnet = (size: number) => Promise<HyperDhtTestnet>;

const require = createRequire(import.meta.url);
const createHyperDhtTestnet = require("hyperdht/testnet") as CreateHyperDhtTestnet;
const noLog = (): void => undefined;

async function listen(server: Server | HttpServer): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("fixture address is unavailable");
  }
  return address.port;
}

async function closeServer(server: Server | HttpServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function exchangeTcp(port: number, payload: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let response = "";
    socket.setEncoding("utf8");
    socket.setTimeout(5_000, () => socket.destroy(new Error("TCP exchange timed out")));
    socket.once("connect", () => socket.end(payload));
    socket.on("data", (chunk) => {
      response += chunk;
    });
    socket.once("error", reject);
    socket.once("close", () => resolve(response));
  });
}

async function requestWithHost(
  port: number,
  host: string,
  requestPath: string,
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const outgoing = request({
      hostname: "127.0.0.1",
      port,
      path: requestPath,
      headers: { host },
    });
    outgoing.once("response", (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.once("end", () => {
        if (response.statusCode !== 200) {
          reject(new Error(`HTTP ${response.statusCode ?? 0}`));
          return;
        }
        resolve(Buffer.concat(chunks));
      });
    });
    outgoing.once("error", reject);
    outgoing.end();
  });
}

async function waitForHttpOk(url: string, timeoutMs = 8_000): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`HTTP endpoint did not recover: ${String(lastError)}`);
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 8_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("one persistent subscriber connection carries Home, Navidrome, and SSH", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kepos-mux-daemon-"));
  const subscriberState = path.join(root, "subscriber");
  const publisherState = path.join(root, "publisher");
  const sshServer = createServer({ allowHalfOpen: true }, (socket) => {
    let request = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      request += chunk;
    });
    socket.on("end", () => socket.end(`ssh:${request}`));
  });
  const navidromeServer = createHttpServer((request, response) => {
    response.writeHead(200, {
      "content-type": "audio/flac",
      "x-request-path": request.url ?? "/",
    });
    response.end(Buffer.alloc(64 * 1024, 7));
  });
  let testnet: HyperDhtTestnet | undefined;
  let publisher: RunningPublisher | undefined;
  let subscriber: RunningSubscriber | undefined;
  let testError: unknown;
  const publisherEvents: Observation[] = [];
  const subscriberEvents: Observation[] = [];

  try {
    const [sshPort, navidromePort] = await Promise.all([
      listen(sshServer),
      listen(navidromeServer),
    ]);
    const subscriberSetup = await setupSubscriber({
      stateDir: subscriberState,
    });
    const publisherSetup = await setupPublisher({
      stateDir: publisherState,
      displayName: "kosmos",
      subscriberPublicKeys: [subscriberSetup.publicKey],
      services: [
        { id: "navidrome", name: "Navidrome", targetPort: navidromePort },
        { id: "ssh", name: "SSH", targetPort: sshPort },
      ],
    });
    await setSubscriberPublisher({
      stateDir: subscriberState,
      label: "kosmos",
      publisherKey: publisherSetup.publisherKey,
    });

    testnet = await createHyperDhtTestnet(3);
    publisher = await startPublisher({
      stateDir: publisherState,
      bootstrap: testnet.bootstrap,
      log: noLog,
      observe: (event) => publisherEvents.push(event),
    });
    subscriber = await startSubscriber({
      stateDir: subscriberState,
      bootstrap: testnet.bootstrap,
      gatewayPort: 0,
      gatewayHost: "0.0.0.0",
      gatewayDomain: "kepos.internal",
      services: [{ id: "ssh", localPort: 0 }],
      log: noLog,
      observe: (event) => subscriberEvents.push(event),
    });

    const ssh = subscriber.services.find((service) => service.id === "ssh");
    assert.ok(ssh);

    const [healthResponse, audioResponse, podResponse, sshResponse] = await Promise.all([
      fetch(`${subscriber.home.url}/healthz`),
      fetch(
        `http://navidrome.localhost:${subscriber.home.port}/rest/stream`,
      ),
      requestWithHost(
        subscriber.home.port,
        "navidrome.kepos.internal",
        "/rest/stream",
      ),
      exchangeTcp(ssh.port, "hello"),
    ]);
    assert.equal(healthResponse.status, 200);
    assert.equal(audioResponse.status, 200);
    assert.equal((await audioResponse.arrayBuffer()).byteLength, 64 * 1024);
    assert.equal(podResponse.byteLength, 64 * 1024);
    assert.equal(sshResponse, "ssh:hello");
    assert.equal(publisher.acceptedConnections(), 1);

    const repeated = await fetch(`${subscriber.home.url}/healthz`);
    assert.equal(repeated.status, 200);
    assert.equal(publisher.acceptedConnections(), 1);
    assert.equal(
      subscriberEvents.filter(({ event }) => event === "outer.connected")
        .length,
      1,
    );
    assert.ok(
      subscriberEvents.filter(({ event }) => event === "channel.open-ok")
        .length >= 3,
    );

    const subscriberConnected = subscriberEvents.find(
      ({ event }) => event === "outer.connected",
    );
    const subscriberChannel = subscriberEvents.find(
      ({ event }) => event === "channel.open-ok",
    );
    assert.ok(subscriberEvents.some(({ event }) => event === "outer.attempt"));
    assert.ok(subscriberEvents.some(({ event }) => event === "outer.handshake"));
    assert.ok(subscriberConnected?.outerId);
    assert.equal(subscriberConnected.route, "auto");
    assert.equal(subscriberChannel?.outerId, subscriberConnected.outerId);
    assert.equal(
      typeof (subscriberChannel?.transport as { udx?: { rtt?: unknown } })
        ?.udx?.rtt,
      "number",
    );
    assert.ok(
      publisherEvents.some(({ event }) => event === "outer.accepted"),
    );
    assert.ok(
      publisherEvents.some(({ event }) => event === "outer.connected"),
    );
  } catch (error) {
    testError = error;
  }

  const cleanup = await Promise.allSettled([
    subscriber?.stop(),
    publisher?.stop(),
    closeServer(sshServer),
    closeServer(navidromeServer),
    testnet?.destroy(),
    rm(root, { recursive: true, force: true }),
  ]);
  const cleanupErrors = cleanup
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason as unknown);
  if (testError || cleanupErrors.length > 0) {
    throw new AggregateError(
      [testError, ...cleanupErrors].filter((error) => error !== undefined),
      "mux daemon test or cleanup failed",
    );
  }
});

test("subscriber stop closes an active service tunnel before its listener", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kepos-mux-stop-"));
  const subscriberState = path.join(root, "subscriber");
  const publisherState = path.join(root, "publisher");
  let acceptTarget: (() => void) | undefined;
  const targetAccepted = new Promise<void>((resolve) => {
    acceptTarget = resolve;
  });
  const target = createServer(() => acceptTarget?.());
  let testnet: HyperDhtTestnet | undefined;
  let publisher: RunningPublisher | undefined;
  let subscriber: RunningSubscriber | undefined;
  let client: ReturnType<typeof createConnection> | undefined;
  let stopping: Promise<void> | undefined;

  try {
    const targetPort = await listen(target);
    const subscriberSetup = await setupSubscriber({ stateDir: subscriberState });
    const publisherSetup = await setupPublisher({
      stateDir: publisherState,
      displayName: "kosmos",
      subscriberPublicKeys: [subscriberSetup.publicKey],
      services: [{ id: "ssh", name: "SSH", targetPort }],
    });
    await setSubscriberPublisher({
      stateDir: subscriberState,
      label: "kosmos",
      publisherKey: publisherSetup.publisherKey,
    });
    testnet = await createHyperDhtTestnet(3);
    publisher = await startPublisher({
      stateDir: publisherState,
      bootstrap: testnet.bootstrap,
      log: noLog,
    });
    subscriber = await startSubscriber({
      stateDir: subscriberState,
      bootstrap: testnet.bootstrap,
      gatewayPort: 0,
      services: [{ id: "ssh", localPort: 0 }],
      log: noLog,
    });
    const ssh = subscriber.services.find((service) => service.id === "ssh");
    assert.ok(ssh);
    client = createConnection({ host: "127.0.0.1", port: ssh.port });
    await Promise.all([once(client, "connect"), targetAccepted]);

    stopping = subscriber.stop();
    await Promise.race([
      stopping,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("subscriber stop timed out")), 1_000);
      }),
    ]);
  } finally {
    client?.destroy();
    await stopping?.catch(() => undefined);
    await Promise.allSettled([
      subscriber?.stop(),
      publisher?.stop(),
      closeServer(target),
      testnet?.destroy(),
      rm(root, { recursive: true, force: true }),
    ]);
  }
});

test("one publisher accepts multiple subscribers with independent connections", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kepos-mux-subscribers-"));
  const publisherState = path.join(root, "publisher");
  const subscriberAState = path.join(root, "subscriber-a");
  const subscriberBState = path.join(root, "subscriber-b");
  let testnet: HyperDhtTestnet | undefined;
  let publisher: RunningPublisher | undefined;
  let subscriberA: RunningSubscriber | undefined;
  let subscriberB: RunningSubscriber | undefined;
  let testError: unknown;

  try {
    const [subscriberASetup, subscriberBSetup] = await Promise.all([
      setupSubscriber({ stateDir: subscriberAState }),
      setupSubscriber({ stateDir: subscriberBState }),
    ]);
    const publisherSetup = await setupPublisher({
      stateDir: publisherState,
      displayName: "kosmos",
      subscriberPublicKeys: [
        subscriberASetup.publicKey,
        subscriberBSetup.publicKey,
      ],
      services: [],
    });
    await Promise.all([
      setSubscriberPublisher({
        stateDir: subscriberAState,
        label: "kosmos",
        publisherKey: publisherSetup.publisherKey,
      }),
      setSubscriberPublisher({
        stateDir: subscriberBState,
        label: "kosmos",
        publisherKey: publisherSetup.publisherKey,
      }),
    ]);

    testnet = await createHyperDhtTestnet(3);
    publisher = await startPublisher({
      stateDir: publisherState,
      bootstrap: testnet.bootstrap,
      log: noLog,
    });
    subscriberA = await startSubscriber({
      stateDir: subscriberAState,
      bootstrap: testnet.bootstrap,
      gatewayPort: 0,
      services: [],
      log: noLog,
    });
    subscriberB = await startSubscriber({
      stateDir: subscriberBState,
      bootstrap: testnet.bootstrap,
      gatewayPort: 0,
      services: [],
      log: noLog,
    });

    const [homeA, homeB] = await Promise.all([
      fetch(`${subscriberA.home.url}/healthz`),
      fetch(`${subscriberB.home.url}/healthz`),
    ]);
    assert.equal(homeA.status, 200);
    assert.equal(homeB.status, 200);
    assert.equal(publisher.acceptedConnections(), 2);
    assert.equal(publisher.activeSubscribers(), 2);
  } catch (error) {
    testError = error;
  }

  const cleanup = await Promise.allSettled([
    subscriberA?.stop(),
    subscriberB?.stop(),
    publisher?.stop(),
    testnet?.destroy(),
    rm(root, { recursive: true, force: true }),
  ]);
  const cleanupErrors = cleanup
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason as unknown);
  if (testError || cleanupErrors.length > 0) {
    throw new AggregateError(
      [testError, ...cleanupErrors].filter((error) => error !== undefined),
      "multi-subscriber test or cleanup failed",
    );
  }
});

test("publisher replaces an older outer for the same subscriber key", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kepos-mux-replace-"));
  const publisherState = path.join(root, "publisher");
  const subscriberState = path.join(root, "subscriber");
  let testnet: HyperDhtTestnet | undefined;
  let publisher: RunningPublisher | undefined;
  let subscriberA: RunningSubscriber | undefined;
  let subscriberB: RunningSubscriber | undefined;
  let testError: unknown;
  const publisherEvents: Observation[] = [];

  try {
    const subscriberSetup = await setupSubscriber({
      stateDir: subscriberState,
    });
    const publisherSetup = await setupPublisher({
      stateDir: publisherState,
      displayName: "kosmos",
      subscriberPublicKeys: [subscriberSetup.publicKey],
      services: [],
    });
    await setSubscriberPublisher({
      stateDir: subscriberState,
      label: "kosmos",
      publisherKey: publisherSetup.publisherKey,
    });
    testnet = await createHyperDhtTestnet(3);
    publisher = await startPublisher({
      stateDir: publisherState,
      bootstrap: testnet.bootstrap,
      log: noLog,
      observe: (event) => {
        publisherEvents.push(event);
        if (event.event === "outer.replaced") {
          void subscriberA?.stop();
        }
      },
    });
    subscriberA = await startSubscriber({
      stateDir: subscriberState,
      bootstrap: testnet.bootstrap,
      gatewayPort: 0,
      services: [],
      log: noLog,
    });
    assert.equal((await fetch(`${subscriberA.home.url}/healthz`)).status, 200);

    subscriberB = await startSubscriber({
      stateDir: subscriberState,
      bootstrap: testnet.bootstrap,
      gatewayPort: 0,
      services: [],
      log: noLog,
    });
    await waitFor(
      () => publisherEvents.some(({ event }) => event === "outer.replaced"),
      "publisher did not replace the older subscriber outer",
    );
    await subscriberA.stop();
    subscriberA = undefined;
    await waitFor(
      () => publisher?.activeSubscribers() === 1,
      "publisher did not retain one current subscriber",
    );

    assert.equal((await fetch(`${subscriberB.home.url}/healthz`)).status, 200);
    assert.equal(publisher.activeSubscribers(), 1);
    assert.ok(publisher.acceptedConnections() >= 2);
    assert.equal(
      publisherEvents.filter(({ event }) => event === "outer.replaced")
        .length,
      1,
    );
  } catch (error) {
    testError = error;
  }

  const cleanup = await Promise.allSettled([
    subscriberA?.stop(),
    subscriberB?.stop(),
    publisher?.stop(),
    testnet?.destroy(),
    rm(root, { recursive: true, force: true }),
  ]);
  const cleanupErrors = cleanup
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason as unknown);
  if (testError || cleanupErrors.length > 0) {
    throw new AggregateError(
      [testError, ...cleanupErrors].filter((error) => error !== undefined),
      "same-subscriber replacement test or cleanup failed",
    );
  }
});

test("publisher denies a non-current outer using the same subscriber key", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kepos-mux-candidate-"));
  const publisherState = path.join(root, "publisher");
  const subscriberState = path.join(root, "subscriber");
  let testnet: HyperDhtTestnet | undefined;
  let publisher: RunningPublisher | undefined;
  let subscriber: RunningSubscriber | undefined;
  let candidateDht: DhtNode | undefined;
  let candidateOuter: DhtStream | undefined;
  let candidateMux: RunningMuxSubscriber | undefined;
  let testError: unknown;

  try {
    const subscriberSetup = await setupSubscriber({
      stateDir: subscriberState,
    });
    const publisherSetup = await setupPublisher({
      stateDir: publisherState,
      displayName: "kosmos",
      subscriberPublicKeys: [subscriberSetup.publicKey],
      services: [],
    });
    await setSubscriberPublisher({
      stateDir: subscriberState,
      label: "kosmos",
      publisherKey: publisherSetup.publisherKey,
    });
    testnet = await createHyperDhtTestnet(3);
    publisher = await startPublisher({
      stateDir: publisherState,
      bootstrap: testnet.bootstrap,
      log: noLog,
    });
    subscriber = await startSubscriber({
      stateDir: subscriberState,
      bootstrap: testnet.bootstrap,
      gatewayPort: 0,
      services: [],
      log: noLog,
    });
    assert.equal((await fetch(`${subscriber.home.url}/healthz`)).status, 200);

    const state = await loadSubscriberState(subscriberState);
    const keyPair = keyPairFromSecretKey(state.identity.secretKey);
    candidateDht = createDht({
      bootstrap: testnet.bootstrap,
      keyPair,
    });
    candidateOuter = candidateDht.connect(
      Buffer.from(publisherSetup.publisherKey, "hex"),
      {
        keyPair,
        localConnection: true,
        reusableSocket: true,
      },
    );
    if (!candidateOuter.connected) await once(candidateOuter, "connect");
    candidateMux = createMuxSubscriber(candidateOuter, {
      heartbeat: false,
    });

    await assert.rejects(
      () => candidateMux!.open("home"),
      /subscriber connection is not current/i,
    );
    assert.equal((await fetch(`${subscriber.home.url}/healthz`)).status, 200);
    assert.equal(publisher.activeSubscribers(), 1);
  } catch (error) {
    testError = error;
  }

  candidateMux?.close();
  const cleanup = await Promise.allSettled([
    subscriber?.stop(),
    publisher?.stop(),
    candidateDht?.destroy({ force: true }),
    testnet?.destroy(),
    rm(root, { recursive: true, force: true }),
  ]);
  const cleanupErrors = cleanup
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason as unknown);
  if (testError || cleanupErrors.length > 0) {
    throw new AggregateError(
      [testError, ...cleanupErrors].filter((error) => error !== undefined),
      "same-subscriber candidate test or cleanup failed",
    );
  }
});

test("publisher allowlist rejects an unknown subscriber", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kepos-mux-denied-"));
  const allowedState = path.join(root, "allowed");
  const unknownState = path.join(root, "unknown");
  const publisherState = path.join(root, "publisher");
  let testnet: HyperDhtTestnet | undefined;
  let publisher: RunningPublisher | undefined;
  let allowed: RunningSubscriber | undefined;
  let unknown: RunningSubscriber | undefined;
  let testError: unknown;
  const publisherEvents: Observation[] = [];

  try {
    const [allowedSetup] = await Promise.all([
      setupSubscriber({ stateDir: allowedState }),
      setupSubscriber({ stateDir: unknownState }),
    ]);
    const publisherSetup = await setupPublisher({
      stateDir: publisherState,
      displayName: "kosmos",
      subscriberPublicKeys: [allowedSetup.publicKey],
      services: [],
    });
    await setSubscriberPublisher({
      stateDir: allowedState,
      label: "kosmos",
      publisherKey: publisherSetup.publisherKey,
    });
    await setSubscriberPublisher({
      stateDir: unknownState,
      label: "kosmos",
      publisherKey: publisherSetup.publisherKey,
    });

    testnet = await createHyperDhtTestnet(3);
    publisher = await startPublisher({
      stateDir: publisherState,
      bootstrap: testnet.bootstrap,
      log: noLog,
      observe: (event) => publisherEvents.push(event),
    });
    await assert.rejects(
      async () => {
        unknown = await startSubscriber({
          stateDir: unknownState,
          bootstrap: testnet?.bootstrap,
          gatewayPort: 0,
          services: [],
          log: noLog,
        });
      },
      /firewall|denied|connection|handshake|closed/i,
    );
    assert.equal(publisher.acceptedConnections(), 0);
    assert.equal(publisher.activeSubscribers(), 0);
    const rejected = publisherEvents.find(
      ({ event }) => event === "outer.rejected",
    );
    assert.ok(rejected?.outerId);
    assert.equal(typeof rejected.remotePublicKey, "string");
    assert.equal((rejected.remotePublicKey as string).length, 16);

    publisher.createPairingInvitation();
    allowed = await startSubscriber({
      stateDir: allowedState,
      bootstrap: testnet.bootstrap,
      gatewayPort: 0,
      services: [],
      log: noLog,
    });
    assert.equal((await fetch(`${allowed.home.url}/healthz`)).status, 200);
    assert.equal(publisher.activeSubscribers(), 1);
  } catch (error) {
    testError = error;
  }

  const cleanup = await Promise.allSettled([
    allowed?.stop(),
    unknown?.stop(),
    publisher?.stop(),
    testnet?.destroy(),
    rm(root, { recursive: true, force: true }),
  ]);
  const cleanupErrors = cleanup
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason as unknown);
  if (testError || cleanupErrors.length > 0) {
    throw new AggregateError(
      [testError, ...cleanupErrors].filter((error) => error !== undefined),
      "allowlist test or cleanup failed",
    );
  }
});

test("publisher approves an unknown subscriber on its pairing outer", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kepos-mux-pairing-"));
  const publisherState = path.join(root, "publisher");
  const subscriberState = path.join(root, "subscriber");
  let testnet: HyperDhtTestnet | undefined;
  let publisher: RunningPublisher | undefined;
  let subscriberDht: DhtNode | undefined;
  let subscriberMux: RunningMuxSubscriber | undefined;
  let testError: unknown;
  const pairingEvents: Observation[] = [];

  try {
    const subscriberSetup = await setupSubscriber({ stateDir: subscriberState });
    const publisherSetup = await setupPublisher({
      stateDir: publisherState,
      displayName: "kosmos",
      subscriberPublicKeys: [],
      services: [],
    });
    await setSubscriberPublisher({
      stateDir: subscriberState,
      label: "kosmos",
      publisherKey: publisherSetup.publisherKey,
    });
    testnet = await createHyperDhtTestnet(3);
    publisher = await startPublisher({
      stateDir: publisherState,
      bootstrap: testnet.bootstrap,
      log: noLog,
      observe: (event) => pairingEvents.push(event),
    });
    const invitation = publisher.createPairingInvitation();
    const parsed = parsePairingInvitation(invitation.uri);
    const state = await loadSubscriberState(subscriberState);
    const keyPair = keyPairFromSecretKey(state.identity.secretKey);
    subscriberDht = createDht({ bootstrap: testnet.bootstrap, keyPair });
    const outer = subscriberDht.connect(
      Buffer.from(publisherSetup.publisherKey, "hex"),
      { keyPair, localConnection: true, reusableSocket: true },
    );
    if (!outer.connected) await once(outer, "connect");
    subscriberMux = createMuxSubscriber(outer, {
      authorized: false,
      heartbeat: false,
    });

    const pairing = subscriberMux.pair({
      token: parsed.token,
      label: "Neil's test device",
      platform: "test",
    });
    await waitFor(
      () => publisher?.pairingStatus().phase === "pending",
      "publisher did not receive the pairing request",
    );
    assert.equal(publisher.activeSubscribers(), 0);
    await assert.rejects(() => subscriberMux!.open("home"), /not approved/i);

    await publisher.approvePairing();
    await pairing;
    const home = await subscriberMux.open("home");
    home.destroy();
    await waitFor(
      () => publisher?.activeSubscribers() === 1,
      "approved subscriber did not become active",
    );
    const persisted = await loadPublisherState(publisherState);
    assert.deepEqual(persisted.config.allow, [subscriberSetup.publicKey]);
    assert.deepEqual(
      pairingEvents
        .filter(({ event }) => event.startsWith("pairing."))
        .map(({ event }) => event),
      [
        "pairing.invitation-created",
        "pairing.requested",
        "pairing.approved",
      ],
    );
    assert.equal(JSON.stringify(pairingEvents).includes(parsed.token), false);
  } catch (error) {
    testError = error;
  }

  subscriberMux?.close();
  const cleanup = await Promise.allSettled([
    publisher?.stop(),
    subscriberDht?.destroy({ force: true }),
    testnet?.destroy(),
    rm(root, { recursive: true, force: true }),
  ]);
  const cleanupErrors = cleanup
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason as unknown);
  if (testError || cleanupErrors.length > 0) {
    throw new AggregateError(
      [testError, ...cleanupErrors].filter((error) => error !== undefined),
      "pairing test or cleanup failed",
    );
  }
});

test("publisher closes an idle pairing candidate when its invitation expires", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kepos-pairing-expiry-"));
  const publisherState = path.join(root, "publisher");
  const subscriberState = path.join(root, "subscriber");
  let now = 1_750_000_000_000;
  let expiryTask:
    | { callback: () => void; cancelled: boolean; delayMs: number }
    | undefined;
  let testnet: HyperDhtTestnet | undefined;
  let publisher: RunningPublisher | undefined;
  let subscriberDht: DhtNode | undefined;
  let candidateOuter: DhtStream | undefined;
  let testError: unknown;
  const pairingEvents: Observation[] = [];

  try {
    await setupSubscriber({ stateDir: subscriberState });
    const publisherSetup = await setupPublisher({
      stateDir: publisherState,
      displayName: "kosmos",
      subscriberPublicKeys: [],
      services: [],
    });
    await setSubscriberPublisher({
      stateDir: subscriberState,
      label: "kosmos",
      publisherKey: publisherSetup.publisherKey,
    });
    const subscriberStateValue = await loadSubscriberState(subscriberState);
    testnet = await createHyperDhtTestnet(3);
    publisher = await startPublisher({
      stateDir: publisherState,
      bootstrap: testnet.bootstrap,
      log: noLog,
      now: () => now,
      observe: (event) => pairingEvents.push(event),
      schedulePairingExpiry: (delayMs, callback) => {
        const task = { callback, cancelled: false, delayMs };
        expiryTask = task;
        return () => {
          task.cancelled = true;
        };
      },
    });
    const invitation = publisher.createPairingInvitation();
    assert.equal(expiryTask?.delayMs, 120_000);

    const keyPair = keyPairFromSecretKey(subscriberStateValue.identity.secretKey);
    subscriberDht = createDht({ bootstrap: testnet.bootstrap, keyPair });
    candidateOuter = subscriberDht.connect(
      Buffer.from(publisherSetup.publisherKey, "hex"),
      { keyPair, localConnection: true, reusableSocket: true },
    );
    if (!candidateOuter.connected) await once(candidateOuter, "connect");
    await waitFor(
      () => publisher?.acceptedConnections() === 1,
      "publisher did not admit the pairing candidate",
    );
    candidateOuter.on("error", () => undefined);
    const closed = new Promise<void>((resolve) => {
      candidateOuter?.once("close", () => resolve());
    });
    now = invitation.expiresAt;
    assert.equal(expiryTask?.cancelled, false);
    expiryTask?.callback();
    await closed;

    assert.equal(candidateOuter.destroyed, true);
    assert.deepEqual(publisher.pairingStatus(), {
      phase: "inviting",
      expiresAt: invitation.expiresAt,
      expired: true,
    });
    assert.equal(publisher.activeSubscribers(), 0);
    assert.equal(
      pairingEvents.some(
        ({ event }) => event === "pairing.invitation-expired",
      ),
      true,
    );
  } catch (error) {
    testError = error;
  }

  const cleanup = await Promise.allSettled([
    publisher?.stop(),
    subscriberDht?.destroy({ force: true }),
    testnet?.destroy(),
    rm(root, { recursive: true, force: true }),
  ]);
  const cleanupErrors = cleanup
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason as unknown);
  if (testError || cleanupErrors.length > 0) {
    const errors = [testError, ...cleanupErrors].filter(
      (error) => error !== undefined,
    );
    throw new AggregateError(
      errors,
      `pairing expiry test or cleanup failed: ${errors.map(String).join("; ")}`,
    );
  }
});

test("publisher persistence failure never authorizes the pairing candidate", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kepos-pairing-persist-fail-"));
  const publisherState = path.join(root, "publisher");
  const subscriberState = path.join(root, "subscriber");
  let testnet: HyperDhtTestnet | undefined;
  let publisher: RunningPublisher | undefined;
  let subscriberDht: DhtNode | undefined;
  let subscriberMux: RunningMuxSubscriber | undefined;
  let testError: unknown;

  try {
    await setupSubscriber({ stateDir: subscriberState });
    const publisherSetup = await setupPublisher({
      stateDir: publisherState,
      displayName: "kosmos",
      subscriberPublicKeys: [],
      services: [],
    });
    await setSubscriberPublisher({
      stateDir: subscriberState,
      label: "kosmos",
      publisherKey: publisherSetup.publisherKey,
    });
    const subscriberStateValue = await loadSubscriberState(subscriberState);
    testnet = await createHyperDhtTestnet(3);
    publisher = await startPublisher({
      stateDir: publisherState,
      bootstrap: testnet.bootstrap,
      log: noLog,
      persistAllowlist: async () => {
        throw new Error("disk full");
      },
    });
    const invitation = parsePairingInvitation(
      publisher.createPairingInvitation().uri,
    );
    const keyPair = keyPairFromSecretKey(subscriberStateValue.identity.secretKey);
    subscriberDht = createDht({ bootstrap: testnet.bootstrap, keyPair });
    const outer = subscriberDht.connect(
      Buffer.from(publisherSetup.publisherKey, "hex"),
      { keyPair, localConnection: true, reusableSocket: true },
    );
    outer.on("error", () => undefined);
    if (!outer.connected) await once(outer, "connect");
    subscriberMux = createMuxSubscriber(outer, {
      authorized: false,
      heartbeat: false,
    });
    const pairing = subscriberMux.pair({
      token: invitation.token,
      label: "Neil's test device",
      platform: "test",
    });
    await waitFor(
      () => publisher?.pairingStatus().phase === "pending",
      "publisher did not receive the persistence-failure candidate",
    );

    await assert.rejects(() => publisher!.approvePairing(), /disk full/);
    assert.equal(publisher.activeSubscribers(), 0);
    assert.equal(publisher.pairingStatus().phase, "pending");
    await assert.rejects(() => subscriberMux!.open("home"), /not approved/i);
    assert.deepEqual((await loadPublisherState(publisherState)).config.allow, []);

    publisher.denyPairing();
    await assert.rejects(pairing, /denied|closed/i);
    await waitFor(() => outer.destroyed, "denied pairing outer stayed open");
    assert.equal(publisher.activeSubscribers(), 0);
    assert.deepEqual(publisher.pairingStatus(), { phase: "idle" });
  } catch (error) {
    testError = error;
  }

  subscriberMux?.close();
  const cleanup = await Promise.allSettled([
    publisher?.stop(),
    subscriberDht?.destroy({ force: true }),
    testnet?.destroy(),
    rm(root, { recursive: true, force: true }),
  ]);
  const cleanupErrors = cleanup
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason as unknown);
  if (testError || cleanupErrors.length > 0) {
    throw new AggregateError(
      [testError, ...cleanupErrors].filter((error) => error !== undefined),
      "pairing persistence-failure test or cleanup failed",
    );
  }
});

test("subscriber runtime pairs and promotes its pending contact without reconnecting", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kepos-runtime-pairing-"));
  const publisherState = path.join(root, "publisher");
  const subscriberState = path.join(root, "subscriber");
  let testnet: HyperDhtTestnet | undefined;
  let publisher: RunningPublisher | undefined;
  let subscriber: RunningSubscriber | undefined;
  let testError: unknown;

  try {
    await setupSubscriber({ stateDir: subscriberState });
    await setupPublisher({
      stateDir: publisherState,
      displayName: "kosmos",
      subscriberPublicKeys: [],
      services: [],
    });
    testnet = await createHyperDhtTestnet(3);
    publisher = await startPublisher({
      stateDir: publisherState,
      bootstrap: testnet.bootstrap,
      log: noLog,
    });
    const invitation = publisher.createPairingInvitation();
    const starting = startSubscriber({
      stateDir: subscriberState,
      bootstrap: testnet.bootstrap,
      gatewayPort: 0,
      services: [],
      log: noLog,
      pairing: {
        invitation: invitation.uri,
        deviceLabel: "Neil's test device",
        platform: "test",
      },
    });

    await waitFor(
      () => publisher?.pairingStatus().phase === "pending",
      "publisher did not receive runtime pairing request",
    );
    await publisher.approvePairing();
    subscriber = await starting;

    assert.equal((await fetch(`${subscriber.home.url}/healthz`)).status, 200);
    assert.equal(publisher.acceptedConnections(), 1);
    assert.equal((await loadSubscriberState(subscriberState)).contact.label, "kosmos");
  } catch (error) {
    testError = error;
  }

  const cleanup = await Promise.allSettled([
    subscriber?.stop(),
    publisher?.stop(),
    testnet?.destroy(),
    rm(root, { recursive: true, force: true }),
  ]);
  const cleanupErrors = cleanup
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason as unknown);
  if (testError || cleanupErrors.length > 0) {
    throw new AggregateError(
      [testError, ...cleanupErrors].filter((error) => error !== undefined),
      "subscriber runtime pairing test or cleanup failed",
    );
  }
});

test("subscriber recovers a pending contact after publisher approval response is lost", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kepos-pairing-recovery-"));
  const publisherState = path.join(root, "publisher");
  const subscriberState = path.join(root, "subscriber");
  let testnet: HyperDhtTestnet | undefined;
  let publisher: RunningPublisher | undefined;
  let subscriber: RunningSubscriber | undefined;
  let testError: unknown;

  try {
    const subscriberSetup = await setupSubscriber({ stateDir: subscriberState });
    const publisherSetup = await setupPublisher({
      stateDir: publisherState,
      displayName: "kosmos",
      subscriberPublicKeys: [subscriberSetup.publicKey],
      services: [],
    });
    await setSubscriberPendingPublisher({
      stateDir: subscriberState,
      label: "kosmos",
      publisherKey: publisherSetup.publisherKey,
    });
    testnet = await createHyperDhtTestnet(3);
    publisher = await startPublisher({
      stateDir: publisherState,
      bootstrap: testnet.bootstrap,
      log: noLog,
    });
    subscriber = await startSubscriber({
      stateDir: subscriberState,
      bootstrap: testnet.bootstrap,
      gatewayPort: 0,
      services: [],
      log: noLog,
    });

    assert.equal((await fetch(`${subscriber.home.url}/healthz`)).status, 200);
    assert.equal((await loadSubscriberState(subscriberState)).contact.label, "kosmos");
  } catch (error) {
    testError = error;
  }

  const cleanup = await Promise.allSettled([
    subscriber?.stop(),
    publisher?.stop(),
    testnet?.destroy(),
    rm(root, { recursive: true, force: true }),
  ]);
  const cleanupErrors = cleanup
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason as unknown);
  if (testError || cleanupErrors.length > 0) {
    throw new AggregateError(
      [testError, ...cleanupErrors].filter((error) => error !== undefined),
      "pairing recovery test or cleanup failed",
    );
  }
});

test("subscriber reconnects in the background without changing local ports", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kepos-mux-reconnect-"));
  const subscriberState = path.join(root, "subscriber");
  const publisherState = path.join(root, "publisher");
  let testnet: HyperDhtTestnet | undefined;
  let publisher: RunningPublisher | undefined;
  let subscriber: RunningSubscriber | undefined;
  let testError: unknown;
  const subscriberEvents: Observation[] = [];

  try {
    const subscriberSetup = await setupSubscriber({
      stateDir: subscriberState,
    });
    const publisherSetup = await setupPublisher({
      stateDir: publisherState,
      displayName: "kosmos",
      subscriberPublicKeys: [subscriberSetup.publicKey],
      services: [],
    });
    await setSubscriberPublisher({
      stateDir: subscriberState,
      label: "kosmos",
      publisherKey: publisherSetup.publisherKey,
    });
    testnet = await createHyperDhtTestnet(3);
    publisher = await startPublisher({
      stateDir: publisherState,
      bootstrap: testnet.bootstrap,
      log: noLog,
    });
    subscriber = await startSubscriber({
      stateDir: subscriberState,
      bootstrap: testnet.bootstrap,
      gatewayPort: 0,
      services: [],
      log: noLog,
      observe: (event) => subscriberEvents.push(event),
    });
    const homeUrl = subscriber.home.url;
    assert.equal((await fetch(`${homeUrl}/healthz`)).status, 200);

    await publisher.stop();
    publisher = await startPublisher({
      stateDir: publisherState,
      bootstrap: testnet.bootstrap,
      log: noLog,
    });

    const recovered = await waitForHttpOk(`${homeUrl}/healthz`);
    assert.equal(recovered.status, 200);
    assert.equal(subscriber.home.url, homeUrl);
    assert.equal(publisher.acceptedConnections(), 1);
    assert.ok(subscriberEvents.some(({ event }) => event === "outer.closed"));
    assert.ok(subscriberEvents.some(({ event }) => event === "outer.restored"));
    const connectedOuterIds = subscriberEvents
      .filter(({ event }) => event === "outer.connected")
      .map(({ outerId }) => outerId);
    assert.equal(connectedOuterIds.length, 2);
    assert.notEqual(connectedOuterIds[0], connectedOuterIds[1]);
  } catch (error) {
    testError = error;
  }

  const cleanup = await Promise.allSettled([
    subscriber?.stop(),
    publisher?.stop(),
    testnet?.destroy(),
    rm(root, { recursive: true, force: true }),
  ]);
  const cleanupErrors = cleanup
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason as unknown);
  if (testError || cleanupErrors.length > 0) {
    throw new AggregateError(
      [testError, ...cleanupErrors].filter((error) => error !== undefined),
      "reconnect test or cleanup failed",
    );
  }
});
