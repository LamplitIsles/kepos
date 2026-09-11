import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  createServer as createHttpServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createConnection, createServer, type Server } from "node:net";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { parsePeerConfig, type PeerConfig } from "../src/config.js";
import { createDht, keyPairFromSeed, type DhtNode } from "../src/mux/hyperdht.js";
import { startPeer, type RunningPeer } from "../src/runtime/peer.js";
import { startSubscriber, type RunningSubscriber } from "../src/runtime/subscriber.js";
import { loadPeerIdentity, setupPeer } from "../src/state/peer.js";
import { setupSubscriber } from "../src/state/subscriber.js";

const require = createRequire(import.meta.url);
const createHyperDhtTestnet = require("hyperdht/testnet") as (
  size: number,
) => Promise<{
  bootstrap: Array<{ host: string; port: number }>;
  destroy: () => Promise<void>;
}>;

test("canonical peers exchange two-way Unix and TCP byte streams over one connection", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kepos-peer-services-"));
  const testnet = await createHyperDhtTestnet(3);
  let aDht: DhtNode | undefined;
  let bDht: DhtNode | undefined;
  let aPeer: RunningPeer | undefined;
  let bPeer: RunningPeer | undefined;
  let aSource: Server | undefined;
  let bSource: Server | undefined;
  try {
    const aState = path.join(root, "a", "peer");
    const bState = path.join(root, "b", "peer");
    const aSetup = await setupPeer({ stateDir: aState });
    const bSetup = await setupPeer({ stateDir: bState });
    const aIdentity = await loadPeerIdentity(aState);
    const bIdentity = await loadPeerIdentity(bState);
    aDht = createDht({
      bootstrap: testnet.bootstrap,
      keyPair: keyPairFromSeed(aIdentity.seed),
    });
    bDht = createDht({
      bootstrap: testnet.bootstrap,
      keyPair: keyPairFromSeed(bIdentity.seed),
    });

    aSource = createServer((socket) => {
      const chunks: Buffer[] = [];
      socket.on("data", (chunk: Buffer) => chunks.push(chunk));
      socket.on("end", () => {
        socket.end(Buffer.concat([Buffer.from("cua-reply:"), ...chunks]));
      });
    });
    const aSourcePath = path.join(root, "a", "cua.sock");
    await listenUnix(aSource, aSourcePath);

    bSource = createServer((socket) => {
      const chunks: Buffer[] = [];
      socket.on("data", (chunk: Buffer) => chunks.push(chunk));
      socket.on("end", () => {
        socket.end(Buffer.concat([Buffer.from("b-reply:"), ...chunks]));
      });
    });
    await listenTcp(bSource);
    const bSourceAddress = bSource.address();
    if (!bSourceAddress || typeof bSourceAddress === "string") {
      throw new Error("test TCP source did not receive an address");
    }

    const bBindingPath = path.join(root, "b", "cua-binding.sock");
    const aConfig = parsePeerConfig({
      gateway: { port: 0 },
      peers: [{ label: "nuc", publicKey: bSetup.publicKey, connection: "dial" }],
      services: [
        {
          id: "cua",
          name: "cua-driver",
          source: { unixSocket: aSourcePath },
          allow: [bSetup.publicKey],
        },
      ],
      bindings: [
        {
          peer: "nuc",
          service: "b-service",
          listen: { localPort: 0 },
        },
      ],
    });
    const bConfig = parsePeerConfig({
      gateway: { port: 0 },
      peers: [{ label: "mac", publicKey: aSetup.publicKey, connection: "accept" }],
      services: [
        {
          id: "b-service",
          name: "B service",
          source: { localPort: bSourceAddress.port },
          allow: [aSetup.publicKey],
        },
      ],
      bindings: [
        {
          peer: "mac",
          service: "cua",
          listen: { unixSocket: bBindingPath },
        },
      ],
    });

    bPeer = await startPeer({ stateDir: bState, config: bConfig, dht: bDht });
    assert.equal(bPeer.status().bindings[0]?.available, false);
    aPeer = await startPeer({ stateDir: aState, config: aConfig, dht: aDht });
    await waitFor(() =>
      aPeer?.status().connections[0]?.status === "connected" &&
      bPeer?.status().connections[0]?.status === "connected" &&
      aPeer?.status().bindings[0]?.available === true &&
      bPeer?.status().bindings[0]?.available === true,
    );

    const aBindingPort = aPeer.status().bindings[0]?.port;
    assert.equal(typeof aBindingPort, "number");
    assert.deepEqual(
      await requestTcp(aBindingPort!, Buffer.from("large:" + "x".repeat(256 * 1024))),
      Buffer.from("b-reply:large:" + "x".repeat(256 * 1024)),
    );
    assert.deepEqual(
      await requestUnix(bBindingPath, Buffer.from('ndjson:{"image":"inline"}')),
      Buffer.from('cua-reply:ndjson:{"image":"inline"}'),
    );

    const activeConfig = bPeer.status();
    assert.equal(activeConfig.connections.length, 1);
    assert.equal(activeConfig.connections[0]?.publicKey, aSetup.publicKey);
  } finally {
    await aPeer?.stop().catch(() => undefined);
    await bPeer?.stop().catch(() => undefined);
    await aDht?.destroy({ force: true }).catch(() => undefined);
    await bDht?.destroy({ force: true }).catch(() => undefined);
    await closeServer(aSource);
    await closeServer(bSource);
    await testnet.destroy();
    await rm(root, { recursive: true, force: true });
  }
});

test("an old subscriber pairs with the canonical accept side and keeps legacy service access", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kepos-peer-legacy-"));
  const testnet = await createHyperDhtTestnet(3);
  let serverDht: DhtNode | undefined;
  let clientDht: DhtNode | undefined;
  let peer: RunningPeer | undefined;
  let subscriber: RunningSubscriber | undefined;
  let target: Server | undefined;
  let httpTarget: Server | undefined;
  try {
    const serverState = path.join(root, "server", "peer");
    const clientState = path.join(root, "client", "subscriber");
    const serverSetup = await setupPeer({ stateDir: serverState });
    await setupSubscriber({ stateDir: clientState });
    const serverIdentity = await loadPeerIdentity(serverState);
    serverDht = createDht({
      bootstrap: testnet.bootstrap,
      keyPair: keyPairFromSeed(serverIdentity.seed),
    });
    clientDht = createDht({ bootstrap: testnet.bootstrap });
    peer = await startPeer({
      stateDir: serverState,
      config: parsePeerConfig({
        gateway: { port: 0 },
        peers: [],
        services: [],
        bindings: [],
      }),
      dht: serverDht,
    });
    const invitation = peer.createPairingInvitation();

    target = createServer((socket) => {
      const chunks: Buffer[] = [];
      socket.on("data", (chunk: Buffer) => chunks.push(chunk));
      socket.on("end", () => {
        socket.end(Buffer.concat([Buffer.from("legacy:"), ...chunks]));
      });
    });
    await listenTcp(target);
    const targetAddress = target.address();
    if (!targetAddress || typeof targetAddress === "string") {
      throw new Error("test legacy source did not receive an address");
    }
    let authorization: string | undefined;
    httpTarget = createHttpServer((request: IncomingMessage, response: ServerResponse) => {
      authorization = request.headers.authorization;
      response.end(`legacy-http:${request.url ?? "/"}`);
    });
    await listenTcp(httpTarget);
    const httpAddress = httpTarget.address();
    if (!httpAddress || typeof httpAddress === "string") {
      throw new Error("test legacy HTTP source did not receive an address");
    }
    const pairingTask = startSubscriber({
      stateDir: clientState,
      dht: clientDht,
      gatewayPort: 0,
      services: [
        { id: "legacy", localPort: 0 },
        { id: "legacy-http", localPort: 0 },
      ],
      pairing: {
        invitation: invitation.uri,
        deviceLabel: "old-phone",
        platform: "android",
      },
    });
    await waitFor(() => peer?.pairingStatus().phase === "pending");
    await peer.approvePairing();
    subscriber = await pairingTask;
    await waitFor(() => peer?.status().connections[0]?.status === "connected");
    assert.equal(peer.status().connections[0]?.capability, "unsupported");

    await peer.applyConfig(
      parsePeerConfig({
        gateway: { port: 0 },
        peers: [
          {
            label: "old-phone",
            publicKey: subscriber.status().subscriberKey,
            connection: "accept",
          },
        ],
        services: [
          {
            id: "legacy",
            name: "Legacy service",
            source: { localPort: targetAddress.port },
            allow: [subscriber.status().subscriberKey],
          },
          {
            id: "legacy-http",
            name: "Legacy HTTP service",
            kind: "http",
            source: { localPort: httpAddress.port },
            allow: [subscriber.status().subscriberKey],
          },
        ],
        bindings: [],
      }),
    );
    const localPort = subscriber.services.find(({ id }) => id === "legacy")?.port;
    assert.equal(typeof localPort, "number");
    assert.deepEqual(
      await requestTcp(localPort!, Buffer.from("payload")),
      Buffer.from("legacy:payload"),
    );
    const httpPort = subscriber.services.find(({ id }) => id === "legacy-http")?.port;
    assert.equal(typeof httpPort, "number");
    assert.deepEqual(
      await requestHttp(httpPort!, "/from-old-client"),
      "legacy-http:/from-old-client",
    );
    assert.equal(authorization, `Kepos ${subscriber.status().subscriberKey}`);
  } finally {
    await subscriber?.stop().catch(() => undefined);
    await peer?.stop().catch(() => undefined);
    await serverDht?.destroy({ force: true }).catch(() => undefined);
    await clientDht?.destroy({ force: true }).catch(() => undefined);
    await closeServer(target);
    await closeServer(httpTarget);
    await testnet.destroy();
    await rm(root, { recursive: true, force: true });
  }
});

test("a canonical peer republishes an upstream service only when explicitly configured", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kepos-peer-republish-"));
  const testnet = await createHyperDhtTestnet(4);
  let macDht: DhtNode | undefined;
  let nucDht: DhtNode | undefined;
  let clientDht: DhtNode | undefined;
  let macPeer: RunningPeer | undefined;
  let nucPeer: RunningPeer | undefined;
  let clientPeer: RunningPeer | undefined;
  let source: Server | undefined;
  try {
    const macState = path.join(root, "mac", "peer");
    const nucState = path.join(root, "nuc", "peer");
    const clientState = path.join(root, "client", "peer");
    const macSetup = await setupPeer({ stateDir: macState });
    const nucSetup = await setupPeer({ stateDir: nucState });
    const clientSetup = await setupPeer({ stateDir: clientState });
    macDht = createDht({
      bootstrap: testnet.bootstrap,
      keyPair: keyPairFromSeed((await loadPeerIdentity(macState)).seed),
    });
    nucDht = createDht({
      bootstrap: testnet.bootstrap,
      keyPair: keyPairFromSeed((await loadPeerIdentity(nucState)).seed),
    });
    clientDht = createDht({
      bootstrap: testnet.bootstrap,
      keyPair: keyPairFromSeed((await loadPeerIdentity(clientState)).seed),
    });

    source = createServer((socket) => {
      const chunks: Buffer[] = [];
      socket.on("data", (chunk: Buffer) => chunks.push(chunk));
      socket.on("end", () => {
        socket.end(Buffer.concat([Buffer.from("upstream:"), ...chunks]));
      });
    });
    const sourcePath = path.join(root, "mac", "cua.sock");
    await listenUnix(source, sourcePath);

    macPeer = await startPeer({
      stateDir: macState,
      dht: macDht,
      config: parsePeerConfig({
        gateway: { port: 0 },
        peers: [{ label: "nuc", publicKey: nucSetup.publicKey, connection: "dial" }],
        services: [{
          id: "cua",
          name: "CUA",
          kind: "tcp",
          source: { unixSocket: sourcePath },
          allow: [nucSetup.publicKey],
        }],
        bindings: [],
      }),
    });
    nucPeer = await startPeer({
      stateDir: nucState,
      dht: nucDht,
      config: parsePeerConfig({
        gateway: { port: 0 },
        peers: [
          { label: "mac", publicKey: macSetup.publicKey, connection: "accept" },
          { label: "client", publicKey: clientSetup.publicKey, connection: "accept" },
        ],
        services: [{
          id: "cua-republished",
          name: "Republished CUA",
          kind: "tcp",
          source: { peer: "mac", service: "cua" },
          allow: [clientSetup.publicKey],
        }],
        bindings: [
          // This local binding consumes the upstream service but deliberately
          // does not make `cua` part of the NUC's published catalog.
          { peer: "mac", service: "cua", listen: { localPort: 0 } },
        ],
      }),
    });
    clientPeer = await startPeer({
      stateDir: clientState,
      dht: clientDht,
      config: parsePeerConfig({
        gateway: { port: 0 },
        peers: [{ label: "nuc", publicKey: nucSetup.publicKey, connection: "dial" }],
        services: [],
        bindings: [
          { peer: "nuc", service: "cua-republished", listen: { localPort: 0 } },
          { peer: "nuc", service: "cua", listen: { localPort: 0 } },
        ],
      }),
    });

    await waitFor(() => Boolean(
      macPeer?.status().connections[0]?.status === "connected" &&
      nucPeer?.status().connections.every(({ status }) => status === "connected") &&
      clientPeer?.status().connections[0]?.status === "connected" &&
      clientPeer?.status().bindings[0]?.available === true,
    ));
    const nucBinding = nucPeer.status().bindings[0];
    const clientRepublishedBinding = clientPeer.status().bindings[0];
    assert.equal(typeof nucBinding?.port, "number");
    assert.equal(typeof clientRepublishedBinding?.port, "number");
    assert.equal(clientPeer.status().bindings[1]?.available, false);

    assert.deepEqual(
      await requestTcp(nucBinding!.port!, Buffer.from("direct")),
      Buffer.from("upstream:direct"),
    );
    assert.deepEqual(
      await requestTcp(clientRepublishedBinding!.port!, Buffer.from("via-nuc")),
      Buffer.from("upstream:via-nuc"),
    );
    await assert.rejects(
      clientPeer.open(nucSetup.publicKey, "cua"),
      /unauthorized or unavailable/i,
    );
    assert.equal(
      nucPeer.status().connections.filter(({ status }) => status === "connected").length,
      2,
    );
  } finally {
    await clientPeer?.stop().catch(() => undefined);
    await nucPeer?.stop().catch(() => undefined);
    await macPeer?.stop().catch(() => undefined);
    await clientDht?.destroy({ force: true }).catch(() => undefined);
    await nucDht?.destroy({ force: true }).catch(() => undefined);
    await macDht?.destroy({ force: true }).catch(() => undefined);
    await closeServer(source);
    await testnet.destroy();
    await rm(root, { recursive: true, force: true });
  }
});

test("canonical peer keeps offline bindings configured and reports local source state", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kepos-peer-status-"));
  const stateDir = path.join(root, "peer");
  const remoteKey = "33".repeat(32);
  let firewall: ((publicKey: Uint8Array) => boolean) | undefined;
  const dht = createFakeDht((options) => {
    firewall = options.firewall;
  });
  let peer: RunningPeer | undefined;
  try {
    await setupPeer({ stateDir });
    const config = parsePeerConfig({
      gateway: { port: 0 },
      peers: [{ label: "remote", publicKey: remoteKey, connection: "accept" }],
      services: [
        {
          id: "tcp",
          name: "TCP",
          source: { localPort: 12_345 },
          allow: [],
        },
        {
          id: "unix",
          name: "Unix",
          source: { unixSocket: path.join(root, "source.sock") },
          allow: [],
        },
        {
          id: "upstream",
          name: "Upstream",
          source: { peer: "remote", service: "remote-service" },
          allow: [],
        },
      ],
      bindings: [
        {
          peer: "remote",
          service: "remote-service",
          listen: { localPort: 0 },
        },
      ],
    });
    peer = await startPeer({
      stateDir,
      config,
      dht,
      serviceAcquisitionTimeoutMs: 10,
    });

    const status = peer.status();
    assert.equal(status.services.find(({ id }) => id === "tcp")?.available, true);
    assert.equal(status.services.find(({ id }) => id === "unix")?.available, true);
    assert.deepEqual(
      status.services.find(({ id }) => id === "upstream"),
      {
        id: "upstream",
        name: "Upstream",
        kind: "tcp",
        source: { peer: "remote", service: "remote-service" },
        available: false,
        error: "Upstream peer is offline",
      },
    );
    const bindingPort = status.bindings[0]?.port;
    assert.equal(typeof bindingPort, "number");
    assert.equal(status.bindings[0]?.available, false);
    assert.equal(status.bindings[0]?.error, "Peer is offline");
    assert.equal(firewall?.(Buffer.from(remoteKey, "hex")), false);
    assert.equal(firewall?.(Buffer.alloc(32, 4)), true);

    await assert.rejects(
      peer.open(remoteKey, "remote-service"),
      /Peer is offline/i,
    );
    assert.equal(await requestGateway(peer.gateway.port, "remote-service"), 503);
    const bindingSocket = createConnection({ host: "127.0.0.1", port: bindingPort! });
    bindingSocket.on("error", () => undefined);
    await once(bindingSocket, "close");

    const invitation = peer.createPairingInvitation();
    assert.equal(peer.pairingStatus().phase, "inviting");
    assert.match(invitation.uri, /^kepos:\/\/pair/);
    peer.cancelPairing();
    assert.equal(peer.pairingStatus().phase, "idle");

    assert.equal(await peer.applyConfig(config), false);
    const changed = parsePeerConfig({
      ...config,
      gateway: { port: 0, domain: "kepos.internal" },
      services: [],
      bindings: [],
    });
    assert.equal(await peer.applyConfig(changed), true);
    assert.equal(peer.status().services.length, 0);
    assert.equal(peer.status().bindings.length, 0);
  } finally {
    await peer?.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("canonical peer rejects occupied Unix bindings and disabled pairing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kepos-peer-errors-"));
  const occupiedPath = path.join(root, "occupied.sock");
  const stateDir = path.join(root, "peer");
  let peer: RunningPeer | undefined;
  try {
    await setupPeer({ stateDir });
    await writeFile(occupiedPath, "foreign");
    const config = parsePeerConfig({
      gateway: { port: 0 },
      peers: [{ label: "remote", publicKey: "44".repeat(32), connection: "accept" }],
      services: [],
      bindings: [
        {
          peer: "remote",
          service: "remote-service",
          listen: { unixSocket: occupiedPath },
        },
      ],
    });
    await assert.rejects(
      startPeer({ stateDir, config, dht: createFakeDht() }),
      /already occupied/i,
    );
    assert.equal(await readFile(occupiedPath, "utf8"), "foreign");

    peer = await startPeer({
      stateDir,
      config: parsePeerConfig({ gateway: { port: 0 }, peers: [], services: [], bindings: [] }),
      dht: createFakeDht(),
      pairing: { enabled: false },
    });
    assert.throws(() => peer?.createPairingInvitation(), /pairing is disabled/i);
  } finally {
    await peer?.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("canonical peer dial retries remain observable and stop cleanly", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kepos-peer-dial-"));
  const stateDir = path.join(root, "peer");
  let peer: RunningPeer | undefined;
  try {
    await setupPeer({ stateDir });
    peer = await startPeer({
      stateDir,
      config: parsePeerConfig({
        gateway: { port: 0 },
        peers: [{ label: "remote", publicKey: "55".repeat(32), connection: "dial" }],
        services: [],
        bindings: [],
      }),
      dht: createFakeDht(),
      sleep: (delayMs) => new Promise((resolve) => setTimeout(resolve, Math.min(delayMs, 5))),
      log: () => undefined,
    });
    await waitFor(() => peer?.status().connections[0]?.status === "reconnecting");
  } finally {
    await peer?.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

async function listenTcp(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function listenUnix(server: Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server?.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function requestTcp(port: number, payload: Buffer): Promise<Buffer> {
  return requestSocket({ port }, payload);
}

function requestUnix(socketPath: string, payload: Buffer): Promise<Buffer> {
  return requestSocket({ path: socketPath }, payload);
}

function requestHttp(port: number, requestPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port,
      path: requestPath,
      headers: { authorization: "Bearer forged" },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    request.once("error", reject);
    request.end();
  });
}

function requestGateway(port: number, serviceId: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port,
      headers: { host: `${serviceId}.localhost:${port}` },
    }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    request.once("error", reject);
    request.end();
  });
}

function requestSocket(
  options: { port: number } | { path: string },
  payload: Buffer,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ ...options, allowHalfOpen: true });
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.once("error", reject);
    socket.once("close", () => resolve(Buffer.concat(chunks)));
    socket.once("connect", () => socket.end(payload));
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for canonical peer state");
}

function createFakeDht(
  onCreateServer?: (options: {
    firewall: (publicKey: Uint8Array) => boolean;
  }) => void,
): DhtNode {
  return {
    stats: {
      punches: { consistent: 0, random: 0, open: 0 },
      relaying: { attempts: 0, successes: 0, aborts: 0 },
    },
    connect: () => {
      throw new Error("fake connection failed");
    },
    createServer: (options) => {
      onCreateServer?.(options);
      return {
        listen: async () => undefined,
        close: async () => undefined,
      };
    },
    destroy: async () => undefined,
  };
}
