import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createSocket, type Socket as UdpSocket } from "node:dgram";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer, request } from "node:http";
import { createConnection, createServer, type Server } from "node:net";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  startPublisher,
  type PublisherRuntimePolicy,
  type RunningPublisher,
} from "../src/runtime/publisher.js";
import { startSubscriber, type RunningSubscriber } from "../src/runtime/subscriber.js";
import { readHomeRegistry } from "../src/runtime/registry-client.js";
import type { HomeRegistry } from "../src/home/registry.js";
import { setupPublisher } from "../src/state/publisher.js";
import {
  setSubscriberPublisher,
  setupSubscriber,
} from "../src/state/subscriber.js";

const require = createRequire(import.meta.url);
const createHyperDhtTestnet = require("hyperdht/testnet") as (
  size: number,
) => Promise<{
  bootstrap: Array<{ host: string; port: number }>;
  destroy: () => Promise<void>;
}>;

function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = (): void => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error("timed out waiting for republication state"));
        return;
      }
      setTimeout(check, 10).unref();
    };
    check();
  });
}

async function waitForRegistry(
  port: number,
  predicate: (registry: HomeRegistry) => boolean,
  timeoutMs = 10_000,
): Promise<HomeRegistry> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const registry = await readHomeRegistry(port, 1_000);
      if (predicate(registry)) return registry;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for registry state: ${String(lastError)}`);
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("republication fixture address is unavailable");
  }
  return address.port;
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server?.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function bindUdp(): Promise<UdpSocket> {
  const socket = createSocket("udp4");
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(0, "127.0.0.1", () => {
      socket.off("error", reject);
      resolve();
    });
  });
  return socket;
}

function udpPort(socket: UdpSocket): number {
  const address = socket.address();
  assert.notEqual(typeof address, "string");
  return address.port;
}

async function closeUdp(socket: UdpSocket | undefined): Promise<void> {
  if (!socket) return;
  await new Promise<void>((resolve) => {
    try {
      socket.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

async function sendUdp(
  socket: UdpSocket,
  port: number,
  payload: Uint8Array,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error("republication UDP exchange timed out"));
    }, 5_000);
    const onMessage = (message: Buffer): void => {
      clearTimeout(timer);
      resolve(Buffer.from(message));
    };
    socket.once("message", onMessage);
    socket.send(payload, port, "127.0.0.1", (error) => {
      if (!error) return;
      clearTimeout(timer);
      socket.off("message", onMessage);
      reject(error);
    });
  });
}

async function exchangeTcp(port: number, payload: string): Promise<string> {
  const socket = createConnection({ host: "127.0.0.1", port });
  socket.setEncoding("utf8");
  const chunks: string[] = [];
  socket.on("data", (chunk: string) => chunks.push(chunk));
  socket.setTimeout(5_000, () => socket.destroy(new Error("republication TCP exchange timed out")));
  await once(socket, "connect");
  socket.end(payload);
  await once(socket, "close");
  return chunks.join("");
}

async function requestHttp(
  port: number,
  host: string,
  requestPath: string,
): Promise<{ body: Buffer; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const outgoing = request({
      host: "127.0.0.1",
      port,
      path: requestPath,
      headers: { host },
    });
    outgoing.once("response", (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      response.once("end", () => {
        if (response.statusCode !== 200) {
          reject(new Error(`republication HTTP ${response.statusCode ?? 0}`));
          return;
        }
        resolve({ body: Buffer.concat(chunks), headers: response.headers });
      });
    });
    outgoing.once("error", reject);
    outgoing.end();
  });
}

function publisherPolicy(
  subscribers: PublisherRuntimePolicy["subscribers"],
  services: PublisherRuntimePolicy["services"],
  displayName: string,
): PublisherRuntimePolicy {
  return { displayName, subscribers, services };
}

test("republishes TCP, HTTP, and UDP through one upstream connection", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kepos-service-republication-"));
  const testnet = await createHyperDhtTestnet(3);
  const tcpServer = createServer((socket) => {
    socket.on("data", (chunk) => {
      const payload = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      socket.write(Buffer.concat([Buffer.from("tcp:"), payload]));
    });
  });
  const secondTcpServer = createServer((socket) => {
    socket.on("data", (chunk) => {
      const payload = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      socket.write(Buffer.concat([Buffer.from("second:"), payload]));
    });
  });
  const httpIdentities: string[] = [];
  const httpServer = createHttpServer((incoming, response) => {
    const identity = incoming.headers.authorization;
    if (typeof identity === "string") httpIdentities.push(identity);
    const body = Buffer.from(`http:${incoming.url ?? ""}`);
    response.writeHead(200, { "content-length": body.byteLength, "content-type": "text/plain" });
    response.end(body);
  });
  const udpServer = await bindUdp();
  udpServer.on("message", (message, remote) => {
    udpServer.send(Buffer.from(message), remote.port, remote.address);
  });

  let original: RunningPublisher | undefined;
  let secondOriginal: RunningPublisher | undefined;
  let republisher: RunningPublisher | undefined;
  let subscriber: RunningSubscriber | undefined;
  let ordinarySubscriber: RunningSubscriber | undefined;
  let localUdp: UdpSocket | undefined;
  let aliasUdp: UdpSocket | undefined;
  let republisherSubscriberState: Awaited<ReturnType<typeof setupSubscriber>> | undefined;
  try {
    const tcpPort = await listen(tcpServer);
    const httpPort = await listen(httpServer);
    const originalStateDir = path.join(root, "original-publisher");
    const secondOriginalStateDir = path.join(root, "second-original-publisher");
    const republisherStateDir = path.join(root, "republisher");
    const finalStateDir = path.join(root, "final-subscriber");
    const originalSetup = await setupPublisher({ stateDir: originalStateDir });
    const secondOriginalSetup = await setupPublisher({ stateDir: secondOriginalStateDir });
    const republisherSetup = await setupPublisher({ stateDir: republisherStateDir });
    republisherSubscriberState = await setupSubscriber({ stateDir: path.join(root, "republisher-subscriber") });
    const finalSetup = await setupSubscriber({ stateDir: finalStateDir });
    await setSubscriberPublisher({
      stateDir: path.join(root, "republisher-subscriber"),
      label: "original",
      publisherKey: originalSetup.publisherKey,
    });
    await setSubscriberPublisher({
      stateDir: finalStateDir,
      label: "republisher",
      publisherKey: republisherSetup.publisherKey,
    });

    original = await startPublisher({
      stateDir: originalStateDir,
      bootstrap: testnet.bootstrap,
      policy: publisherPolicy(
        [
          { publicKey: republisherSetup.publisherKey, label: "republisher" },
          { publicKey: republisherSubscriberState.publicKey, label: "ordinary subscriber" },
        ],
        [
          { id: "source-tcp", name: "Source TCP", source: { localPort: tcpPort } },
          { id: "source-http", name: "Source HTTP", kind: "http", source: { localPort: httpPort } },
          { id: "source-udp", name: "Source UDP", kind: "udp", source: { localPort: udpPort(udpServer) } },
        ],
        "original",
      ),
    });
    secondOriginal = await startPublisher({
      stateDir: secondOriginalStateDir,
      bootstrap: testnet.bootstrap,
      policy: publisherPolicy(
        [{ publicKey: republisherSetup.publisherKey, label: "republisher" }],
        [{ id: "source-second", name: "Second source", source: { localPort: await listen(secondTcpServer) } }],
        "second original",
      ),
    });
    republisher = await startPublisher({
      stateDir: republisherStateDir,
      bootstrap: testnet.bootstrap,
      policy: publisherPolicy(
        [{ publicKey: finalSetup.publicKey, label: "final" }],
        [
          {
            id: "echo",
            name: "Republished TCP",
            source: { publisherKey: originalSetup.publisherKey, serviceId: "source-tcp" },
          },
          {
            id: "site",
            name: "Republished HTTP",
            kind: "http",
            source: { publisherKey: originalSetup.publisherKey, serviceId: "source-http" },
          },
          {
            id: "game",
            name: "Republished UDP",
            kind: "udp",
            source: { publisherKey: originalSetup.publisherKey, serviceId: "source-udp" },
          },
          {
            id: "game-alias",
            name: "Republished UDP alias",
            kind: "udp",
            source: { publisherKey: originalSetup.publisherKey, serviceId: "source-udp" },
          },
          {
            id: "second",
            name: "Republished second TCP",
            source: { publisherKey: secondOriginalSetup.publisherKey, serviceId: "source-second" },
          },
        ],
        "republisher",
      ),
    });

    await waitFor(() => republisher?.serviceStatus?.().every(({ available }) => available) === true);
    ordinarySubscriber = await startSubscriber({
      stateDir: path.join(root, "republisher-subscriber"),
      bootstrap: testnet.bootstrap,
      gatewayPort: 0,
      services: [],
    });
    await waitFor(() => ordinarySubscriber?.status().connection === "connected");
    assert.equal(ordinarySubscriber.publisherKey, originalSetup.publisherKey);
    assert.equal(ordinarySubscriber.status().subscriberKey, republisherSubscriberState.publicKey);
    subscriber = await startSubscriber({
      stateDir: finalStateDir,
      bootstrap: testnet.bootstrap,
      gatewayPort: 0,
      services: [
        { id: "echo", localPort: 0 },
        { id: "second", localPort: 0 },
        { id: "game", kind: "udp", localPort: 0 },
        { id: "game-alias", kind: "udp", localPort: 0 },
      ],
    });

    assert.equal(await exchangeTcp(subscriber.services.find(({ id }) => id === "echo")!.port, "payload"), "tcp:payload");
    assert.equal(await exchangeTcp(subscriber.services.find(({ id }) => id === "echo")!.port, "again"), "tcp:again");
    assert.equal(await exchangeTcp(subscriber.services.find(({ id }) => id === "second")!.port, "payload"), "second:payload");
    const httpResponse = await requestHttp(subscriber.home.port, "site.localhost", "/through-republisher");
    assert.equal(httpResponse.body.toString(), "http:/through-republisher");
    assert.deepEqual(httpIdentities, [`Kepos ${republisherSetup.publisherKey}`]);

    localUdp = await bindUdp();
    aliasUdp = await bindUdp();
    const gamePort = subscriber.services.find(({ id }) => id === "game")!.port;
    const aliasPort = subscriber.services.find(({ id }) => id === "game-alias")!.port;
    for (const size of [0, 1_198, 1_200]) {
      const payload = Buffer.alloc(size, size % 251);
      assert.deepEqual(await sendUdp(localUdp, gamePort, payload), payload);
    }
    assert.deepEqual(await sendUdp(localUdp, aliasPort, Buffer.from("alias")), Buffer.from("alias"));
    assert.deepEqual(await sendUdp(aliasUdp, gamePort, Buffer.from("second-sender")), Buffer.from("second-sender"));

    assert.equal(republisherSubscriberState.publicKey !== republisherSetup.publisherKey, true);
    assert.equal(republisher.publisherKey, republisherSetup.publisherKey);
  } finally {
    await closeUdp(localUdp);
    await closeUdp(aliasUdp);
    await subscriber?.stop();
    await ordinarySubscriber?.stop();
    await republisher?.stop();
    await secondOriginal?.stop();
    await original?.stop();
    await closeServer(tcpServer);
    await closeServer(secondTcpServer);
    await closeServer(httpServer);
    await closeUdp(udpServer);
    await testnet.destroy();
    await rm(root, { recursive: true, force: true });
  }
});

test("republished services retain endpoints across source denial, recovery, and edits", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kepos-service-republication-recovery-"));
  const testnet = await createHyperDhtTestnet(3);
  const firstServer = createServer((socket) => {
    socket.on("data", (chunk) => {
      const payload = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      socket.end(Buffer.concat([Buffer.from("first:"), payload]));
    });
  });
  const secondServer = createServer((socket) => {
    socket.on("data", (chunk) => {
      const payload = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      socket.end(Buffer.concat([Buffer.from("second:"), payload]));
    });
  });
  let original: RunningPublisher | undefined;
  let republisher: RunningPublisher | undefined;
  let subscriber: RunningSubscriber | undefined;
  try {
    const firstPort = await listen(firstServer);
    const secondPort = await listen(secondServer);
    const originalStateDir = path.join(root, "original-publisher");
    const republisherStateDir = path.join(root, "republisher");
    const subscriberStateDir = path.join(root, "subscriber");
    const originalSetup = await setupPublisher({ stateDir: originalStateDir });
    const republisherSetup = await setupPublisher({ stateDir: republisherStateDir });
    const subscriberSetup = await setupSubscriber({ stateDir: subscriberStateDir });
    await setSubscriberPublisher({
      stateDir: subscriberStateDir,
      label: "republisher",
      publisherKey: republisherSetup.publisherKey,
    });

    const originalPolicy: PublisherRuntimePolicy = publisherPolicy(
      [{ publicKey: republisherSetup.publisherKey, label: "republisher" }],
      [
        { id: "source-one", name: "Source one", source: { localPort: firstPort } },
        { id: "source-two", name: "Source two", source: { localPort: secondPort } },
      ],
      "original",
    );
    const republisherPolicy: PublisherRuntimePolicy = publisherPolicy(
      [{ publicKey: subscriberSetup.publicKey, label: "subscriber" }],
      [
        {
          id: "alias",
          name: "Republished alias",
          source: { publisherKey: originalSetup.publisherKey, serviceId: "source-one" },
        },
        {
          id: "wrong-kind",
          name: "Wrong kind",
          kind: "udp",
          source: { publisherKey: originalSetup.publisherKey, serviceId: "source-one" },
        },
      ],
      "republisher",
    );
    original = await startPublisher({
      stateDir: originalStateDir,
      bootstrap: testnet.bootstrap,
      policy: originalPolicy,
    });
    republisher = await startPublisher({
      stateDir: republisherStateDir,
      bootstrap: testnet.bootstrap,
      policy: republisherPolicy,
    });
    await waitFor(() => republisher?.serviceStatus?.().find(({ id }) => id === "alias")?.available === true);
    await waitFor(() => republisher?.serviceStatus?.().find(({ id }) => id === "wrong-kind")?.error?.includes("incompatible") === true);
    subscriber = await startSubscriber({
      stateDir: subscriberStateDir,
      bootstrap: testnet.bootstrap,
      gatewayPort: 0,
      services: [{ id: "alias", localPort: 0 }],
    });
    const aliasListener = subscriber.services.find(({ id }) => id === "alias");
    assert.ok(aliasListener);
    assert.equal(await exchangeTcp(aliasListener.port, "before"), "first:before");

    await original.applyPolicy({
      ...originalPolicy,
      services: originalPolicy.services.map((service) =>
        service.id === "source-one" ? { ...service, allow: [] } : service,
      ),
    });
    await waitFor(() => republisher?.serviceStatus?.().find(({ id }) => id === "alias")?.available === false);
    const deniedRegistry = await waitForRegistry(
      subscriber.home.port,
      (registry) => registry.services.some(({ id, available }) => id === "alias" && available === false),
    );
    const deniedService = deniedRegistry.services.find(({ id }) => id === "alias");
    assert.equal(deniedService?.available, false);
    assert.match(deniedService?.error ?? "", /missing|unauthorized/i);
    assert.equal(await exchangeTcp(aliasListener.port, "denied"), "");

    await original.applyPolicy(originalPolicy);
    await waitFor(() => republisher?.serviceStatus?.().find(({ id }) => id === "alias")?.available === true);
    await waitForRegistry(
      subscriber.home.port,
      (registry) => registry.services.some(({ id, available }) => id === "alias" && available !== false),
    );
    assert.equal(await exchangeTcp(aliasListener.port, "recovered"), "first:recovered");

    const replacementPolicy: PublisherRuntimePolicy = {
      ...republisherPolicy,
      services: republisherPolicy.services.map((service) =>
        service.id === "alias"
          ? { ...service, source: { publisherKey: originalSetup.publisherKey, serviceId: "source-two" } }
          : service,
      ),
    };
    assert.equal(await republisher.applyPolicy(replacementPolicy), true);
    await waitFor(() => republisher?.serviceStatus?.().find(({ id }) => id === "alias")?.available === true);
    assert.equal(await exchangeTcp(aliasListener.port, "replaced"), "second:replaced");

    const deniedDownstreamPolicy: PublisherRuntimePolicy = {
      ...replacementPolicy,
      services: replacementPolicy.services.map((service) =>
        service.id === "alias" ? { ...service, allow: [] } : service,
      ),
    };
    assert.equal(await republisher.applyPolicy(deniedDownstreamPolicy), true);
    const omittedRegistry = await waitForRegistry(
      subscriber.home.port,
      (registry) => !registry.services.some(({ id }) => id === "alias"),
    );
    assert.equal(omittedRegistry.services.some(({ id }) => id === "alias"), false);
    assert.equal(await exchangeTcp(aliasListener.port, "downstream-denied"), "");

    await republisher.applyPolicy(replacementPolicy);
    await waitForRegistry(
      subscriber.home.port,
      (registry) => registry.services.some(({ id, available }) => id === "alias" && available !== false),
    );
    assert.equal(await exchangeTcp(aliasListener.port, "downstream-recovered"), "second:downstream-recovered");
  } finally {
    await subscriber?.stop();
    await republisher?.stop();
    await original?.stop();
    await closeServer(firstServer);
    await closeServer(secondServer);
    await testnet.destroy();
    await rm(root, { recursive: true, force: true });
  }
});
