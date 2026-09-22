import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { request as httpRequest } from "node:http";
import { createSocket, type Socket } from "node:dgram";
import { createConnection, createServer, type Server } from "node:net";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Duplex } from "node:stream";
import { test } from "node:test";

import { loadKeposConfig, saveKeposConfig } from "../src/app-config.js";
import { parsePeerConfig, type PeerConfig } from "../src/config.js";
import {
  createDht,
  keyPairFromSeed,
  type DhtNode,
  type DhtStream,
} from "../src/mux/hyperdht.js";
import {
  decodeUdpEnvelope,
  encodeUdpEnvelope,
  type SubscriberDatagramConnection,
} from "../src/mux/udp.js";
import { startPeer, type RunningPeer } from "../src/runtime/peer.js";
import { listenPeerUdpBinding } from "../src/runtime/udp-binding.js";
import type { Observation } from "../src/mux/observability.js";
import { loadPeerIdentity, setupPeer } from "../src/state/peer.js";

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
  const aObservations: Observation[] = [];
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
      peers: [
        { label: "nuc", publicKey: bSetup.publicKey, connection: "dial" },
      ],
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
      peers: [
        { label: "mac", publicKey: aSetup.publicKey, connection: "accept" },
      ],
      services: [
        {
          id: "b-service",
          name: "B service",
          source: { localPort: bSourceAddress.port },
          allow: [aSetup.publicKey],
        },
        {
          id: "b-web",
          name: "B web",
          kind: "http",
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
    aPeer = await startPeer({
      stateDir: aState,
      config: aConfig,
      dht: aDht,
      observe: (observation) => aObservations.push(observation),
    });
    await waitFor(
      () =>
        aPeer?.status().connections[0]?.status === "connected" &&
        bPeer?.status().connections[0]?.status === "connected" &&
        aPeer?.status().bindings[0]?.available === true &&
        bPeer?.status().bindings[0]?.available === true,
    );
    await delay(1_100);
    assert.equal(
      aObservations.some(
        ({ event, serviceId }) =>
          event === "channel.open" && serviceId === "home",
      ),
      false,
    );

    const aBindingPort = aPeer.status().bindings[0]?.port;
    assert.equal(typeof aBindingPort, "number");
    assert.deepEqual(
      await requestTcp(
        aBindingPort!,
        Buffer.from("large:" + "x".repeat(256 * 1024)),
      ),
      Buffer.from("b-reply:large:" + "x".repeat(256 * 1024)),
    );
    assert.deepEqual(
      await requestUnix(bBindingPath, Buffer.from('ndjson:{"image":"inline"}')),
      Buffer.from('cua-reply:ndjson:{"image":"inline"}'),
    );
    await waitFor(
      () =>
        aPeer
          ?.status()
          .services.some(
            (service) => service.id === "b-web" && service.available,
          ) === true,
    );
    assert.deepEqual(
      aPeer.status().services.find(({ id }) => id === "b-web"),
      {
        id: "b-web",
        name: "B web",
        kind: "tcp",
        source: { peer: "nuc", service: "b-web" },
        available: true,
        access: "http",
        action: "open",
        icon: "web",
        url: `http://b-web.localhost:${aPeer.gateway.port}/`,
        peer: "nuc",
      },
    );

    await waitFor(
      () =>
        bPeer
          ?.status()
          .services.some(
            (service) => service.id === "cua" && service.available,
          ) === true,
    );
    await aPeer.stop();
    await waitFor(
      () =>
        bPeer
          ?.status()
          .services.some(
            (service) => service.id === "cua" && !service.available,
          ) === true,
    );
    assert.match(
      bPeer.status().services.find(({ id }) => id === "cua")?.error ?? "",
      /offline|unavailable|catalog/i,
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

test("canonical service actions select an explicit same-ID peer without fallback", async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), "kepos-peer-service-selection-"),
  );
  const testnet = await createHyperDhtTestnet(4);
  let oneDht: DhtNode | undefined;
  let twoDht: DhtNode | undefined;
  let consumerDht: DhtNode | undefined;
  let onePeer: RunningPeer | undefined;
  let twoPeer: RunningPeer | undefined;
  let consumerPeer: RunningPeer | undefined;
  let oneSource: Server | undefined;
  let twoSource: Server | undefined;
  try {
    const oneState = path.join(root, "one", "peer");
    const twoState = path.join(root, "two", "peer");
    const consumerState = path.join(root, "consumer", "peer");
    const oneSetup = await setupPeer({ stateDir: oneState });
    const twoSetup = await setupPeer({ stateDir: twoState });
    const consumerSetup = await setupPeer({ stateDir: consumerState });
    oneDht = createDht({
      bootstrap: testnet.bootstrap,
      keyPair: keyPairFromSeed((await loadPeerIdentity(oneState)).seed),
    });
    twoDht = createDht({
      bootstrap: testnet.bootstrap,
      keyPair: keyPairFromSeed((await loadPeerIdentity(twoState)).seed),
    });
    consumerDht = createDht({
      bootstrap: testnet.bootstrap,
      keyPair: keyPairFromSeed((await loadPeerIdentity(consumerState)).seed),
    });

    oneSource = createServer((socket) => {
      socket.once("data", () => {
        socket.end(
          "HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\none",
        );
      });
    });
    twoSource = createServer((socket) => {
      socket.once("data", () => {
        socket.end(
          "HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\ntwo",
        );
      });
    });
    await listenTcp(oneSource);
    await listenTcp(twoSource);
    const oneAddress = oneSource.address();
    const twoAddress = twoSource.address();
    if (
      !oneAddress ||
      typeof oneAddress === "string" ||
      !twoAddress ||
      typeof twoAddress === "string"
    ) {
      throw new Error("same-ID HTTP sources did not receive addresses");
    }

    const providerConfig = (key: string, port: number) =>
      parsePeerConfig({
        gateway: { port: 0 },
        peers: [
          {
            label: "consumer",
            publicKey: consumerSetup.publicKey,
            connection: "accept",
          },
        ],
        services: [
          {
            id: "docs",
            name: "Docs",
            kind: "http",
            source: { localPort: port },
            allow: [key],
          },
        ],
        bindings: [],
      });
    const consumerConfig = (bindings: PeerConfig["bindings"]) =>
      parsePeerConfig({
        gateway: { port: 0 },
        peers: [
          {
            label: "peer-one",
            publicKey: oneSetup.publicKey,
            connection: "dial",
          },
          {
            label: "peer-two",
            publicKey: twoSetup.publicKey,
            connection: "dial",
          },
        ],
        services: [],
        bindings,
      });

    onePeer = await startPeer({
      stateDir: oneState,
      dht: oneDht,
      config: providerConfig(consumerSetup.publicKey, oneAddress.port),
    });
    twoPeer = await startPeer({
      stateDir: twoState,
      dht: twoDht,
      config: providerConfig(consumerSetup.publicKey, twoAddress.port),
    });
    consumerPeer = await startPeer({
      stateDir: consumerState,
      dht: consumerDht,
      serviceAcquisitionTimeoutMs: 100,
      config: consumerConfig([
        {
          peer: "peer-one",
          service: "docs",
          listen: { localPort: 0 },
        },
      ]),
    });

    await waitFor(() => {
      const status = consumerPeer?.status();
      return (
        status?.connections.length === 2 &&
        status.connections.every(
          ({ status: connectionStatus }) => connectionStatus === "connected",
        ) &&
        status.services.find(({ id }) => id === "docs")?.available === true
      );
    });
    let docs = consumerPeer.status().services.find(({ id }) => id === "docs");
    assert.equal(
      consumerPeer.status().services.filter(({ id }) => id === "docs").length,
      1,
    );
    assert.equal(docs?.name, "Docs");
    assert.equal(docs?.peer, "peer-one");
    assert.equal(docs?.action, "copy-endpoint");
    assert.match(docs?.copyText ?? "", /^127\.0\.0\.1:\d+$/);
    assert.equal(docs?.url, undefined);
    assert.deepEqual(
      await requestGatewayBody(consumerPeer.gateway.port, "docs"),
      { status: 200, body: "one" },
    );

    await consumerPeer.applyConfig(consumerConfig([]));
    await waitFor(() => {
      docs = consumerPeer?.status().services.find(({ id }) => id === "docs");
      return docs?.available === false && /ambiguous/i.test(docs.error ?? "");
    });
    assert.equal(
      consumerPeer.status().services.filter(({ id }) => id === "docs").length,
      1,
    );
    assert.equal(await requestGateway(consumerPeer.gateway.port, "docs"), 502);

    await consumerPeer.applyConfig(
      consumerConfig([
        {
          peer: "peer-one",
          service: "docs",
          listen: { localPort: 0 },
        },
      ]),
    );
    await waitFor(
      () =>
        consumerPeer?.status().services.find(({ id }) => id === "docs")
          ?.available === true,
    );
    await onePeer.stop();
    onePeer = undefined;
    await waitFor(() => {
      docs = consumerPeer?.status().services.find(({ id }) => id === "docs");
      return (
        docs?.available === false &&
        docs.peer === "peer-one" &&
        /offline|unavailable|catalog/i.test(docs.error ?? "")
      );
    });
    assert.equal(
      consumerPeer.status().services.find(({ id }) => id === "docs")?.available,
      false,
    );
  } finally {
    await consumerPeer?.stop().catch(() => undefined);
    await twoPeer?.stop().catch(() => undefined);
    await onePeer?.stop().catch(() => undefined);
    await consumerDht?.destroy({ force: true }).catch(() => undefined);
    await twoDht?.destroy({ force: true }).catch(() => undefined);
    await oneDht?.destroy({ force: true }).catch(() => undefined);
    await closeServer(oneSource);
    await closeServer(twoSource);
    await testnet.destroy();
    await rm(root, { recursive: true, force: true });
  }
});

test("canonical UDP bindings round-trip through a dial connection and recover after revocation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kepos-peer-udp-binding-"));
  const testnet = await createHyperDhtTestnet(3);
  let providerDht: DhtNode | undefined;
  let consumerDht: DhtNode | undefined;
  let provider: RunningPeer | undefined;
  let consumer: RunningPeer | undefined;
  let target: Socket | undefined;
  let local: Socket | undefined;
  try {
    const providerState = path.join(root, "provider", "peer");
    const consumerState = path.join(root, "consumer", "peer");
    const providerSetup = await setupPeer({ stateDir: providerState });
    const consumerSetup = await setupPeer({ stateDir: consumerState });
    const providerIdentity = await loadPeerIdentity(providerState);
    const consumerIdentity = await loadPeerIdentity(consumerState);
    providerDht = createDht({
      bootstrap: testnet.bootstrap,
      keyPair: keyPairFromSeed(providerIdentity.seed),
    });
    consumerDht = createDht({
      bootstrap: testnet.bootstrap,
      keyPair: keyPairFromSeed(consumerIdentity.seed),
    });

    target = createSocket("udp4");
    await bindUdpSocket(target);
    target.on("message", (message, remote) => {
      target!.send(
        Buffer.concat([Buffer.from("udp-binding:"), message]),
        remote.port,
        remote.address,
      );
    });
    const targetAddress = target.address();
    if (!targetAddress || typeof targetAddress === "string") {
      throw new Error("UDP binding target did not receive an address");
    }

    const providerConfig = (allow: string[]) =>
      parsePeerConfig({
        metrics: { host: "127.0.0.1", port: 0 },
        gateway: { port: 0 },
        peers: [
          {
            label: "consumer",
            publicKey: consumerSetup.publicKey,
            connection: "accept",
          },
        ],
        services: [
          {
            id: "game",
            name: "Game",
            kind: "udp",
            source: { localPort: targetAddress.port },
            allow,
          },
        ],
        bindings: [],
      });
    provider = await startPeer({
      stateDir: providerState,
      config: providerConfig([consumerSetup.publicKey]),
      dht: providerDht,
    });
    consumer = await startPeer({
      stateDir: consumerState,
      config: parsePeerConfig({
        gateway: { port: 0 },
        peers: [
          {
            label: "provider",
            publicKey: providerSetup.publicKey,
            connection: "dial",
          },
        ],
        services: [],
        bindings: [
          {
            peer: "provider",
            service: "game",
            kind: "udp",
            listen: { localPort: 0 },
          },
        ],
      }),
      dht: consumerDht,
    });
    await waitFor(
      () =>
        provider?.status().connections[0]?.status === "connected" &&
        consumer?.status().bindings[0]?.available === true,
    );
    assert.equal(
      provider.status().metrics?.url.startsWith("http://127.0.0.1:"),
      true,
    );
    const metricsResponse = await fetch(provider.status().metrics!.url);
    assert.equal(metricsResponse.status, 200);
    assert.match(
      await metricsResponse.text(),
      /kepos_publisher_subscriber_connected/,
    );

    local = createSocket("udp4");
    await bindUdpSocket(local);
    const bindingPort = consumer.status().bindings[0]?.port;
    assert.equal(typeof bindingPort, "number");
    assert.equal(
      (
        await sendUdpDatagram(local, bindingPort!, Buffer.from("hello"))
      ).toString(),
      "udp-binding:hello",
    );
    const metricsAfterDatagram = await fetch(
      provider.status().metrics!.url,
    ).then((response) => response.text());
    assert.match(
      metricsAfterDatagram,
      /service_bytes_total\{direction="subscriber_to_publisher",service="game"[^}]+\} 5/,
    );
    assert.match(
      metricsAfterDatagram,
      /service_bytes_total\{direction="publisher_to_subscriber",service="game"[^}]+\} 17/,
    );

    await provider.applyConfig(providerConfig([]));
    await waitFor(() => consumer?.status().bindings[0]?.available === false);
    assert.match(
      consumer.status().bindings[0]?.error ?? "",
      /unauthorized|unavailable/i,
    );
    await assert.rejects(
      sendUdpDatagram(local, bindingPort!, Buffer.from("revoked"), 250),
      /timed out|closed|refused/i,
    );

    await provider.applyConfig(providerConfig([consumerSetup.publicKey]));
    await waitFor(() => consumer?.status().bindings[0]?.available === true);
    assert.equal(
      (
        await sendUdpDatagram(local, bindingPort!, Buffer.from("reconnected"))
      ).toString(),
      "udp-binding:reconnected",
    );
  } finally {
    await consumer?.stop().catch(() => undefined);
    await provider?.stop().catch(() => undefined);
    await consumerDht?.destroy({ force: true }).catch(() => undefined);
    await providerDht?.destroy({ force: true }).catch(() => undefined);
    await closeUdp(local);
    await closeUdp(target);
    await testnet.destroy();
    await rm(root, { recursive: true, force: true });
  }
});

test("canonical UDP bindings stay unavailable when their peer direction is accept", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kepos-peer-udp-direction-"));
  const testnet = await createHyperDhtTestnet(3);
  let acceptDht: DhtNode | undefined;
  let dialDht: DhtNode | undefined;
  let acceptPeer: RunningPeer | undefined;
  let dialPeer: RunningPeer | undefined;
  let target: Socket | undefined;
  let local: Socket | undefined;
  try {
    const acceptState = path.join(root, "accept", "peer");
    const dialState = path.join(root, "dial", "peer");
    const acceptSetup = await setupPeer({ stateDir: acceptState });
    const dialSetup = await setupPeer({ stateDir: dialState });
    acceptDht = createDht({
      bootstrap: testnet.bootstrap,
      keyPair: keyPairFromSeed((await loadPeerIdentity(acceptState)).seed),
    });
    dialDht = createDht({
      bootstrap: testnet.bootstrap,
      keyPair: keyPairFromSeed((await loadPeerIdentity(dialState)).seed),
    });
    target = createSocket("udp4");
    await bindUdpSocket(target);
    target.on("message", (message, remote) => {
      target!.send(
        Buffer.concat([Buffer.from("accept-direction:"), message]),
        remote.port,
        remote.address,
      );
    });
    const targetAddress = target.address();
    if (!targetAddress || typeof targetAddress === "string") {
      throw new Error("accept-direction UDP target did not receive an address");
    }

    acceptPeer = await startPeer({
      stateDir: acceptState,
      dht: acceptDht,
      config: parsePeerConfig({
        gateway: { port: 0 },
        peers: [
          {
            label: "dial",
            publicKey: dialSetup.publicKey,
            connection: "accept",
          },
        ],
        services: [],
        bindings: [
          {
            peer: "dial",
            service: "game",
            kind: "udp",
            listen: { localPort: 0 },
          },
        ],
      }),
    });
    dialPeer = await startPeer({
      stateDir: dialState,
      dht: dialDht,
      config: parsePeerConfig({
        gateway: { port: 0 },
        peers: [
          {
            label: "accept",
            publicKey: acceptSetup.publicKey,
            connection: "dial",
          },
        ],
        services: [
          {
            id: "game",
            name: "Game",
            kind: "udp",
            source: { localPort: targetAddress.port },
            allow: [acceptSetup.publicKey],
          },
        ],
        bindings: [],
      }),
    });

    await waitFor(() => {
      const status = acceptPeer?.status();
      return (
        status?.connections[0]?.status === "connected" &&
        status.services.find(({ id }) => id === "game")?.available === false &&
        status.bindings[0]?.available === false
      );
    });
    assert.equal(
      acceptPeer.status().bindings[0]?.error,
      "UDP bindings require a dial-side peer connection",
    );
    assert.equal(
      acceptPeer.status().services.find(({ id }) => id === "game")?.error,
      "UDP bindings require a dial-side peer connection",
    );

    local = createSocket("udp4");
    await bindUdpSocket(local);
    const bindingPort = acceptPeer.status().bindings[0]?.port;
    if (typeof bindingPort !== "number") {
      throw new Error("accept-direction binding has no port");
    }
    await assert.rejects(
      sendUdpDatagram(
        local,
        bindingPort!,
        Buffer.from("must-not-forward"),
        100,
      ),
      /timed out|unavailable/i,
    );
  } finally {
    await dialPeer?.stop().catch(() => undefined);
    await acceptPeer?.stop().catch(() => undefined);
    await dialDht?.destroy({ force: true }).catch(() => undefined);
    await acceptDht?.destroy({ force: true }).catch(() => undefined);
    await closeUdp(local);
    await closeUdp(target);
    await testnet.destroy();
    await rm(root, { recursive: true, force: true });
  }
});

test("canonical local UDP bindings isolate carrier generations and flow state", async () => {
  const sent: Uint8Array[] = [];
  const errors: string[] = [];
  const drops: string[] = [];
  const messageListeners = new Set<(message: Uint8Array) => void>();
  const resetListeners = new Set<() => void>();
  let available = true;
  let sendResult: { ok: boolean; error?: string } = { ok: true };
  const carrier: SubscriberDatagramConnection = {
    available: () => available,
    send: async (message) => {
      sent.push(Buffer.from(message));
      return sendResult;
    },
    onError: () => () => undefined,
    onMessage: (listener) => {
      messageListeners.add(listener);
      return () => messageListeners.delete(listener);
    },
    onReset: (listener) => {
      resetListeners.add(listener);
      return () => resetListeners.delete(listener);
    },
  };
  const binding = await listenPeerUdpBinding("game", 0, {
    idleTimeoutMs: 100,
    maxFlows: 1,
    onError: (error) => errors.push(error),
    onDrop: (reason) => drops.push(reason),
  });
  let local: Socket | undefined;
  try {
    local = createSocket("udp4");
    await bindUdpSocket(local);
    binding.setConnection(carrier, 1);
    binding.setConnection(carrier, 1);

    const reply = sendUdpDatagram(local, binding.port, Buffer.from("hello"));
    await waitFor(() => sent.length === 1);
    const outbound = decodeUdpEnvelope(sent.shift()!);
    assert.equal(outbound.type, "data");
    assert.equal(outbound.serviceId, "game");
    for (const listener of messageListeners) {
      listener(
        encodeUdpEnvelope({
          type: "data",
          serviceId: "game",
          flowId: outbound.flowId,
          payload: Buffer.from("reply"),
        }),
      );
    }
    assert.equal((await reply).toString(), "reply");

    for (const listener of messageListeners) {
      listener(Uint8Array.of(1));
      listener(
        encodeUdpEnvelope({
          type: "data",
          serviceId: "other",
          flowId: outbound.flowId,
          payload: Buffer.from("wrong"),
        }),
      );
      listener(
        encodeUdpEnvelope({
          type: "data",
          serviceId: "game",
          flowId: new Uint8Array(16).fill(7),
          payload: Buffer.from("unknown"),
        }),
      );
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(drops.includes("malformed-envelope"));
    assert.ok(drops.includes("wrong-service"));
    assert.ok(drops.includes("unknown-flow"));

    available = false;
    await assert.rejects(
      sendUdpDatagram(local, binding.port, Buffer.from("offline"), 30),
      /timed out/i,
    );
    assert.ok(errors.some((error) => /unavailable/i.test(error)));
    available = true;

    for (const listener of resetListeners) listener();
    assert.ok(errors.some((error) => /reset/i.test(error)));
    sendResult = { ok: false, error: "carrier denied" };
    const denied = sendUdpDatagram(
      local,
      binding.port,
      Buffer.from("denied"),
      30,
    );
    await waitFor(() => sent.length === 1);
    assert.equal(decodeUdpEnvelope(sent.shift()!).type, "data");
    await assert.rejects(denied, /timed out/i);
    assert.ok(errors.some((error) => /carrier denied/i.test(error)));

    sendResult = { ok: true };
    const expired = sendUdpDatagram(
      local,
      binding.port,
      Buffer.from("expire"),
      30,
    );
    await waitFor(() => sent.length === 1);
    const expiredEnvelope = decodeUdpEnvelope(sent.shift()!);
    await assert.rejects(expired, /timed out/i);
    await new Promise((resolve) => setTimeout(resolve, 120));
    for (const listener of messageListeners) {
      listener(
        encodeUdpEnvelope({
          type: "close",
          serviceId: "game",
          flowId: expiredEnvelope.flowId,
          payload: new Uint8Array(),
        }),
      );
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(drops.includes("unknown-flow"));

    binding.setConnection(undefined, 2);
    await assert.rejects(
      sendUdpDatagram(local, binding.port, Buffer.from("no-carrier"), 30),
      /timed out/i,
    );
  } finally {
    await binding.close();
    await binding.close();
    await closeUdp(local);
  }
});

test("pair approval survives stop, config reload, and a fresh peer connection", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kepos-peer-pair-reload-"));
  const testnet = await createHyperDhtTestnet(4);
  let serverDht: DhtNode | undefined;
  let clientDht: DhtNode | undefined;
  let serverPeer: RunningPeer | undefined;
  let clientPeer: RunningPeer | undefined;
  try {
    const serverState = path.join(root, "server", "peer");
    const clientState = path.join(root, "client", "peer");
    const configPath = path.join(root, "server", "config.toml");
    const serverSetup = await setupPeer({ stateDir: serverState });
    const clientSetup = await setupPeer({ stateDir: clientState });
    const serverIdentity = await loadPeerIdentity(serverState);
    const initialConfig = parsePeerConfig({
      gateway: { port: 0 },
      peers: [],
      services: [],
      bindings: [],
    });
    await saveKeposConfig(initialConfig, configPath);
    serverDht = createDht({
      bootstrap: testnet.bootstrap,
      keyPair: keyPairFromSeed(serverIdentity.seed),
    });
    const clientIdentity = await loadPeerIdentity(clientState);
    clientDht = createDht({
      bootstrap: testnet.bootstrap,
      keyPair: keyPairFromSeed(clientIdentity.seed),
    });
    serverPeer = await startPeer({
      stateDir: serverState,
      config: initialConfig,
      dht: serverDht,
      persistConfig: (config) => saveKeposConfig(config, configPath),
    });
    clientPeer = await startPeer({
      stateDir: clientState,
      config: initialConfig,
      dht: clientDht,
      persistConfig: async () => undefined,
    });

    const invitation = serverPeer.createPairingInvitation();
    const pairingTask = clientPeer.pair(
      invitation.uri,
      "phone",
      "android",
    );
    await waitFor(() => serverPeer?.pairingStatus().phase === "pending");
    await serverPeer.approvePairing();
    await pairingTask;
    await waitFor(
      () =>
        serverPeer?.status().connections[0]?.status === "connected" &&
        clientPeer?.status().connections[0]?.status === "connected",
    );

    const persisted = await loadKeposConfig(configPath);
    assert.deepEqual(persisted?.peers, [
      {
        label: "phone",
        publicKey: clientSetup.publicKey,
        connection: "accept",
      },
    ]);
    await clientPeer.stop();
    clientPeer = undefined;
    await clientDht.destroy({ force: true });
    clientDht = undefined;
    await serverPeer.stop();
    serverPeer = undefined;
    await serverDht.destroy({ force: true });
    serverDht = undefined;

    const reloaded = await loadKeposConfig(configPath);
    assert.deepEqual(reloaded?.peers, persisted?.peers);
    serverDht = createDht({
      bootstrap: testnet.bootstrap,
      keyPair: keyPairFromSeed(serverIdentity.seed),
    });
    serverPeer = await startPeer({
      stateDir: serverState,
      config: reloaded!,
      dht: serverDht,
    });
    const reloadedClientIdentity = await loadPeerIdentity(clientState);
    clientDht = createDht({
      bootstrap: testnet.bootstrap,
      keyPair: keyPairFromSeed(reloadedClientIdentity.seed),
    });
    clientPeer = await startPeer({
      stateDir: clientState,
      config: parsePeerConfig({
        gateway: { port: 0 },
        peers: [
          {
            label: "server",
            publicKey: serverSetup.publicKey,
            connection: "dial",
          },
        ],
        services: [],
        bindings: [],
      }),
      dht: clientDht,
    });
    await waitFor(
      () =>
        serverPeer?.status().connections[0]?.status === "connected" &&
        clientPeer?.status().connections[0]?.status === "connected" &&
        serverPeer.status().connections[0]?.services === 1 &&
        clientPeer.status().connections[0]?.services === 1,
    );
    assert.deepEqual(serverPeer.status().connections[0], {
      label: "phone",
      publicKey: clientSetup.publicKey,
      connection: "accept",
      status: "connected",
      generation: 1,
      services: 1,
    });
  } finally {
    await clientPeer?.stop().catch(() => undefined);
    await serverPeer?.stop().catch(() => undefined);
    await clientDht?.destroy({ force: true }).catch(() => undefined);
    await serverDht?.destroy({ force: true }).catch(() => undefined);
    await testnet.destroy();
    await rm(root, { recursive: true, force: true });
  }
});

test("canonical grant revocation closes active channels and blocks new opens", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kepos-peer-revoke-"));
  const testnet = await createHyperDhtTestnet(3);
  let aDht: DhtNode | undefined;
  let bDht: DhtNode | undefined;
  let aPeer: RunningPeer | undefined;
  let bPeer: RunningPeer | undefined;
  let source: Server | undefined;
  try {
    const aState = path.join(root, "a", "peer");
    const bState = path.join(root, "b", "peer");
    const aSetup = await setupPeer({ stateDir: aState });
    const bSetup = await setupPeer({ stateDir: bState });
    aDht = createDht({
      bootstrap: testnet.bootstrap,
      keyPair: keyPairFromSeed((await loadPeerIdentity(aState)).seed),
    });
    bDht = createDht({
      bootstrap: testnet.bootstrap,
      keyPair: keyPairFromSeed((await loadPeerIdentity(bState)).seed),
    });
    source = createServer(() => undefined);
    await listenTcp(source);
    const sourceAddress = source.address();
    if (!sourceAddress || typeof sourceAddress === "string") {
      throw new Error("revocation source did not receive an address");
    }
    const allowedConfig = parsePeerConfig({
      gateway: { port: 0 },
      peers: [{ label: "b", publicKey: bSetup.publicKey, connection: "dial" }],
      services: [
        {
          id: "protected",
          name: "Protected",
          source: { localPort: sourceAddress.port },
          allow: [bSetup.publicKey],
        },
      ],
      bindings: [],
    });
    const bConfig = parsePeerConfig({
      gateway: { port: 0 },
      peers: [
        { label: "a", publicKey: aSetup.publicKey, connection: "accept" },
      ],
      services: [],
      bindings: [],
    });
    bPeer = await startPeer({ stateDir: bState, config: bConfig, dht: bDht });
    aPeer = await startPeer({
      stateDir: aState,
      config: allowedConfig,
      dht: aDht,
    });
    await waitFor(
      () =>
        aPeer?.status().connections[0]?.status === "connected" &&
        bPeer?.status().connections[0]?.status === "connected" &&
        bPeer.status().connections[0]?.services === 2,
    );

    const channel = await bPeer.open(aSetup.publicKey, "protected");
    let closed = false;
    const closedTask = new Promise<void>((resolve) => {
      channel.once("error", () => undefined);
      channel.once("close", () => {
        closed = true;
        resolve();
      });
    });
    const revokedConfig = parsePeerConfig({
      ...allowedConfig,
      services: [
        {
          ...allowedConfig.services[0]!,
          allow: [],
        },
      ],
    });
    assert.equal(await aPeer.applyConfig(revokedConfig), true);
    await closedTask;
    assert.equal(closed, true);
    await assert.rejects(
      bPeer.open(aSetup.publicKey, "protected"),
      /unauthorized or unavailable/i,
    );
  } finally {
    await bPeer?.stop().catch(() => undefined);
    await aPeer?.stop().catch(() => undefined);
    await bDht?.destroy({ force: true }).catch(() => undefined);
    await aDht?.destroy({ force: true }).catch(() => undefined);
    await closeServer(source);
    await testnet.destroy();
    await rm(root, { recursive: true, force: true });
  }
});

test("canonical bindings do not replay an offline request after reconnection", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kepos-peer-reconnect-"));
  const testnet = await createHyperDhtTestnet(3);
  let aDht: DhtNode | undefined;
  let bDht: DhtNode | undefined;
  let aPeer: RunningPeer | undefined;
  let bPeer: RunningPeer | undefined;
  let source: Server | undefined;
  let staleSocket: import("node:net").Socket | undefined;
  try {
    const aState = path.join(root, "a", "peer");
    const bState = path.join(root, "b", "peer");
    const aSetup = await setupPeer({ stateDir: aState });
    const bSetup = await setupPeer({ stateDir: bState });
    bDht = createDht({
      bootstrap: testnet.bootstrap,
      keyPair: keyPairFromSeed((await loadPeerIdentity(bState)).seed),
    });
    const bConfig = parsePeerConfig({
      gateway: { port: 0 },
      peers: [{ label: "a", publicKey: aSetup.publicKey, connection: "dial" }],
      services: [],
      bindings: [{ peer: "a", service: "echo", listen: { localPort: 0 } }],
    });
    bPeer = await startPeer({
      stateDir: bState,
      config: bConfig,
      dht: bDht,
      serviceAcquisitionTimeoutMs: 5_000,
    });
    const bindingPort = bPeer.status().bindings[0]?.port;
    assert.equal(typeof bindingPort, "number");
    await waitFor(() => bPeer?.status().connections[0]?.status !== "connected");

    staleSocket = createConnection({ host: "127.0.0.1", port: bindingPort! });
    staleSocket.on("error", () => undefined);
    staleSocket.end(Buffer.from("stale"));
    const staleClosed = new Promise<boolean>((resolve) => {
      if (staleSocket?.destroyed) {
        resolve(true);
        return;
      }
      staleSocket?.once("close", () => resolve(true));
    });
    await Promise.race([staleClosed, delay(100)]);

    const received: Buffer[] = [];
    source = createServer((socket) => {
      const chunks: Buffer[] = [];
      socket.on("data", (chunk: Buffer) => chunks.push(chunk));
      socket.on("end", () => {
        const payload = Buffer.concat(chunks);
        received.push(payload);
        socket.end(Buffer.concat([Buffer.from("echo:"), payload]));
      });
    });
    await listenTcp(source);
    const sourceAddress = source.address();
    if (!sourceAddress || typeof sourceAddress === "string") {
      throw new Error("reconnect source did not receive an address");
    }
    aDht = createDht({
      bootstrap: testnet.bootstrap,
      keyPair: keyPairFromSeed((await loadPeerIdentity(aState)).seed),
    });
    aPeer = await startPeer({
      stateDir: aState,
      config: parsePeerConfig({
        gateway: { port: 0 },
        peers: [
          { label: "b", publicKey: bSetup.publicKey, connection: "accept" },
        ],
        services: [
          {
            id: "echo",
            name: "Echo",
            source: { localPort: sourceAddress.port },
            allow: [bSetup.publicKey],
          },
        ],
        bindings: [],
      }),
      dht: aDht,
    });
    await waitFor(
      () =>
        bPeer?.status().connections[0]?.status === "connected" &&
        bPeer.status().bindings[0]?.available === true,
    );
    await delay(100);
    assert.deepEqual(received, []);
    assert.deepEqual(
      await requestTcp(bindingPort!, Buffer.from("fresh")),
      Buffer.from("echo:fresh"),
    );
    assert.deepEqual(received, [Buffer.from("fresh")]);

    const firstGeneration = bPeer.status().connections[0]?.generation ?? 0;
    await aPeer.stop();
    aPeer = undefined;
    await aDht.destroy({ force: true });
    aDht = undefined;
    await waitFor(() => bPeer?.status().connections[0]?.status !== "connected");

    aDht = createDht({
      bootstrap: testnet.bootstrap,
      keyPair: keyPairFromSeed((await loadPeerIdentity(aState)).seed),
    });
    aPeer = await startPeer({
      stateDir: aState,
      config: parsePeerConfig({
        gateway: { port: 0 },
        peers: [
          { label: "b", publicKey: bSetup.publicKey, connection: "accept" },
        ],
        services: [
          {
            id: "echo",
            name: "Echo",
            source: { localPort: sourceAddress.port },
            allow: [bSetup.publicKey],
          },
        ],
        bindings: [],
      }),
      dht: aDht,
    });
    await waitFor(
      () =>
        bPeer?.status().connections[0]?.status === "connected" &&
        (bPeer.status().connections[0]?.generation ?? 0) > firstGeneration,
    );
    assert.deepEqual(
      await requestTcp(bindingPort!, Buffer.from("after-reconnect")),
      Buffer.from("echo:after-reconnect"),
    );
  } finally {
    staleSocket?.destroy();
    await bPeer?.stop().catch(() => undefined);
    await aPeer?.stop().catch(() => undefined);
    await bDht?.destroy({ force: true }).catch(() => undefined);
    await aDht?.destroy({ force: true }).catch(() => undefined);
    await closeServer(source);
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
        peers: [
          { label: "nuc", publicKey: nucSetup.publicKey, connection: "dial" },
        ],
        services: [
          {
            id: "cua",
            name: "CUA",
            kind: "tcp",
            source: { unixSocket: sourcePath },
            allow: [nucSetup.publicKey],
          },
        ],
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
          {
            label: "client",
            publicKey: clientSetup.publicKey,
            connection: "accept",
          },
        ],
        services: [
          {
            id: "cua-republished",
            name: "Republished CUA",
            kind: "tcp",
            source: { peer: "mac", service: "cua" },
            allow: [clientSetup.publicKey],
          },
        ],
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
        peers: [
          { label: "nuc", publicKey: nucSetup.publicKey, connection: "dial" },
        ],
        services: [],
        bindings: [
          { peer: "nuc", service: "cua-republished", listen: { localPort: 0 } },
          { peer: "nuc", service: "cua", listen: { localPort: 0 } },
        ],
      }),
    });

    await waitFor(() =>
      Boolean(
        macPeer?.status().connections[0]?.status === "connected" &&
        nucPeer
          ?.status()
          .connections.every(({ status }) => status === "connected") &&
        clientPeer?.status().connections[0]?.status === "connected" &&
        clientPeer?.status().bindings[0]?.available === true,
      ),
    );
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
    await closeServer(source);
    source = undefined;
    await assert.rejects(
      clientPeer.open(nucSetup.publicKey, "cua-republished"),
      /connect|refused|unavailable|closed/i,
    );
    await waitFor(
      () => clientPeer?.status().bindings[0]?.available === false,
      1_000,
    );
    assert.equal(
      clientPeer
        .status()
        .connections.every(({ status }) => status === "connected"),
      true,
    );
    assert.equal(
      nucPeer
        .status()
        .connections.filter(({ status }) => status === "connected").length,
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

test("canonical UDP republication uses the authenticated upstream peer and returns replies", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kepos-peer-udp-republish-"));
  const testnet = await createHyperDhtTestnet(4);
  let macDht: DhtNode | undefined;
  let nucDht: DhtNode | undefined;
  let clientDht: DhtNode | undefined;
  let macPeer: RunningPeer | undefined;
  let nucPeer: RunningPeer | undefined;
  let clientPeer: RunningPeer | undefined;
  let clientSocket: Socket | undefined;
  let target: import("node:dgram").Socket | undefined;
  try {
    const macState = path.join(root, "mac", "peer");
    const nucState = path.join(root, "nuc", "peer");
    const clientState = path.join(root, "client", "peer");
    const macSetup = await setupPeer({ stateDir: macState });
    const nucSetup = await setupPeer({ stateDir: nucState });
    const clientSetup = await setupPeer({ stateDir: clientState });
    const macIdentity = await loadPeerIdentity(macState);
    const nucIdentity = await loadPeerIdentity(nucState);
    const clientIdentity = await loadPeerIdentity(clientState);
    macDht = createDht({
      bootstrap: testnet.bootstrap,
      keyPair: keyPairFromSeed(macIdentity.seed),
    });
    nucDht = createDht({
      bootstrap: testnet.bootstrap,
      keyPair: keyPairFromSeed(nucIdentity.seed),
    });
    clientDht = createDht({
      bootstrap: testnet.bootstrap,
      keyPair: keyPairFromSeed(clientIdentity.seed),
    });

    const { createSocket } = await import("node:dgram");
    target = createSocket("udp4");
    await new Promise<void>((resolve, reject) => {
      target!.once("error", reject);
      target!.bind(0, "127.0.0.1", () => {
        target!.off("error", reject);
        resolve();
      });
    });
    target.on("message", (message, remote) => {
      target!.send(
        Buffer.concat([Buffer.from("udp-upstream:"), message]),
        remote.port,
        remote.address,
      );
    });
    const targetAddress = target.address();
    if (typeof targetAddress === "string")
      throw new Error("UDP target has no address");

    macPeer = await startPeer({
      stateDir: macState,
      dht: macDht,
      config: parsePeerConfig({
        gateway: { port: 0 },
        peers: [
          { label: "nuc", publicKey: nucSetup.publicKey, connection: "dial" },
        ],
        services: [
          {
            id: "game",
            name: "Game",
            kind: "udp",
            source: { localPort: targetAddress.port },
            allow: [nucSetup.publicKey],
          },
        ],
        bindings: [],
      }),
    });
    const initialNucConfig = parsePeerConfig({
      gateway: { port: 0 },
      peers: [
        { label: "mac", publicKey: macSetup.publicKey, connection: "accept" },
        { label: "phone", publicKey: clientSetup.publicKey, connection: "accept" },
      ],
      services: [
        {
          id: "game-republished",
          name: "Republished game",
          kind: "udp",
          source: { peer: "mac", service: "game" },
          allow: [clientSetup.publicKey],
        },
      ],
      bindings: [],
    });
    nucPeer = await startPeer({
      stateDir: nucState,
      dht: nucDht,
      config: initialNucConfig,
      persistConfig: async () => undefined,
    });
    await waitFor(
      () =>
        macPeer?.status().connections[0]?.status === "connected" &&
        nucPeer?.status().connections[0]?.status === "connected" &&
        nucPeer.status().services[0]?.available === true,
    );

    clientPeer = await startPeer({
      stateDir: clientState,
      dht: clientDht,
      config: parsePeerConfig({
        gateway: { port: 0 },
        peers: [
          { label: "nuc", publicKey: nucSetup.publicKey, connection: "dial" },
        ],
        services: [],
        bindings: [
          {
            peer: "nuc",
            service: "game-republished",
            kind: "udp",
            listen: { localPort: 0 },
          },
        ],
      }),
    });
    await waitFor(
      () =>
        clientPeer?.status().connections[0]?.status === "connected" &&
        clientPeer.status().bindings[0]?.available === true,
    );
    const bindingPort = clientPeer.status().bindings[0]?.port;
    assert.equal(typeof bindingPort, "number");
    clientSocket = createSocket("udp4");
    await bindUdpSocket(clientSocket);
    assert.equal(
      (await sendUdpDatagram(clientSocket, bindingPort!, Buffer.from("datagram"))).toString(),
      "udp-upstream:datagram",
    );
  } finally {
    await clientPeer?.stop().catch(() => undefined);
    await nucPeer?.stop().catch(() => undefined);
    await macPeer?.stop().catch(() => undefined);
    await clientDht?.destroy({ force: true }).catch(() => undefined);
    await nucDht?.destroy({ force: true }).catch(() => undefined);
    await macDht?.destroy({ force: true }).catch(() => undefined);
    await closeUdp(clientSocket);
    await closeUdp(target);
    await testnet.destroy();
    await rm(root, { recursive: true, force: true });
  }
});

test("canonical peer removes its DHT wake listener when startup validation fails", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kepos-peer-wakeup-startup-"));
  const stateDir = path.join(root, "peer");
  try {
    const setup = await setupPeer({ stateDir });
    const dht = createFakeDht() as DhtNode & {
      on: (event: string, listener: () => void) => DhtNode;
      off: (event: string, listener: () => void) => DhtNode;
    };
    let wakeListener: (() => void) | undefined;
    dht.on = (event, listener) => {
      if (event === "wakeup") wakeListener = listener;
      return dht;
    };
    dht.off = (event, listener) => {
      if (event === "wakeup" && wakeListener === listener)
        wakeListener = undefined;
      return dht;
    };
    await assert.rejects(
      startPeer({
        stateDir,
        dht,
        config: parsePeerConfig({
          gateway: { port: 0 },
          peers: [
            { label: "self", publicKey: setup.publicKey, connection: "accept" },
          ],
          services: [],
          bindings: [],
        }),
      }),
      /must not list the local peer/u,
    );
    assert.equal(wakeListener, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("canonical peer does not install a DHT wake listener before server construction", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kepos-peer-wakeup-server-"));
  const stateDir = path.join(root, "peer");
  try {
    await setupPeer({ stateDir });
    const dht = createFakeDht() as DhtNode & {
      on: (event: string, listener: () => void) => DhtNode;
      createServer: DhtNode["createServer"];
    };
    let wakeListenerCount = 0;
    dht.on = (event) => {
      if (event === "wakeup") wakeListenerCount++;
      return dht;
    };
    dht.createServer = () => {
      throw new Error("server construction failed");
    };
    await assert.rejects(
      startPeer({
        stateDir,
        dht,
        config: parsePeerConfig({
          gateway: { port: 0 },
          peers: [],
          services: [],
          bindings: [],
        }),
      }),
      /server construction failed/u,
    );
    assert.equal(wakeListenerCount, 0);
  } finally {
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
    assert.equal(
      status.services.find(({ id }) => id === "tcp")?.available,
      true,
    );
    assert.equal(
      status.services.find(({ id }) => id === "unix")?.available,
      true,
    );
    assert.deepEqual(
      status.services.find(({ id }) => id === "upstream"),
      {
        id: "upstream",
        name: "Upstream",
        kind: "tcp",
        source: { peer: "remote", service: "remote-service" },
        available: false,
        error: "Upstream peer is offline",
        access: "http",
        action: "open",
        icon: "web",
        url: `http://upstream.localhost:${peer.gateway.port}/`,
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
    assert.equal(
      await requestGateway(peer.gateway.port, "remote-service"),
      503,
    );
    const bindingSocket = createConnection({
      host: "127.0.0.1",
      port: bindingPort!,
    });
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

test("canonical peer records and expires a failed local source acquisition", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kepos-peer-source-error-"));
  const testnet = await createHyperDhtTestnet(3);
  let aDht: DhtNode | undefined;
  let bDht: DhtNode | undefined;
  let aPeer: RunningPeer | undefined;
  let bPeer: RunningPeer | undefined;
  let unusedSource: Server | undefined;
  try {
    const aState = path.join(root, "a", "peer");
    const bState = path.join(root, "b", "peer");
    const aSetup = await setupPeer({ stateDir: aState });
    const bSetup = await setupPeer({ stateDir: bState });
    unusedSource = createServer();
    await listenTcp(unusedSource);
    const address = unusedSource.address();
    if (!address || typeof address === "string") {
      throw new Error("source-error fixture did not receive an address");
    }
    const closedPort = address.port;
    await closeServer(unusedSource);
    unusedSource = undefined;

    aDht = createDht({
      bootstrap: testnet.bootstrap,
      keyPair: keyPairFromSeed((await loadPeerIdentity(aState)).seed),
    });
    bDht = createDht({
      bootstrap: testnet.bootstrap,
      keyPair: keyPairFromSeed((await loadPeerIdentity(bState)).seed),
    });
    aPeer = await startPeer({
      stateDir: aState,
      dht: aDht,
      config: parsePeerConfig({
        gateway: { port: 0 },
        peers: [
          { label: "b", publicKey: bSetup.publicKey, connection: "accept" },
        ],
        services: [
          {
            id: "broken",
            name: "Broken source",
            source: { localPort: closedPort },
            allow: [bSetup.publicKey],
          },
        ],
        bindings: [],
      }),
    });
    bPeer = await startPeer({
      stateDir: bState,
      dht: bDht,
      config: parsePeerConfig({
        gateway: { port: 0 },
        peers: [
          { label: "a", publicKey: aSetup.publicKey, connection: "dial" },
        ],
        services: [],
        bindings: [],
      }),
    });
    await waitFor(
      () =>
        bPeer?.status().connections[0]?.status === "connected" &&
        (bPeer.status().connections[0]?.services ?? 0) >= 2,
    );
    await assert.rejects(
      bPeer.open(aSetup.publicKey, "broken"),
      /refused|failed|source/i,
    );
    await waitFor(
      () =>
        aPeer?.status().services.find(({ id }) => id === "broken")
          ?.available === false,
    );
    const failed = aPeer.status().services.find(({ id }) => id === "broken");
    assert.equal(failed?.available, false);
    assert.match(failed?.error ?? "", /refused|connect/i);
    await delay(1_100);
    assert.equal(
      aPeer.status().services.find(({ id }) => id === "broken")?.available,
      true,
    );
  } finally {
    await bPeer?.stop().catch(() => undefined);
    await aPeer?.stop().catch(() => undefined);
    await bDht?.destroy({ force: true }).catch(() => undefined);
    await aDht?.destroy({ force: true }).catch(() => undefined);
    await closeServer(unusedSource);
    await testnet.destroy();
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
      peers: [
        { label: "remote", publicKey: "44".repeat(32), connection: "accept" },
      ],
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
      config: parsePeerConfig({
        gateway: { port: 0 },
        peers: [],
        services: [],
        bindings: [],
      }),
      dht: createFakeDht(),
      pairing: { enabled: false },
    });
    assert.throws(
      () => peer?.createPairingInvitation(),
      /pairing is disabled/i,
    );
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
        peers: [
          { label: "remote", publicKey: "55".repeat(32), connection: "dial" },
        ],
        services: [],
        bindings: [],
      }),
      dht: createFakeDht(),
      sleep: (delayMs) =>
        new Promise((resolve) => setTimeout(resolve, Math.min(delayMs, 5))),
      log: () => undefined,
    });
    await waitFor(
      () => peer?.status().connections[0]?.status === "reconnecting",
    );
  } finally {
    await peer?.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("canonical peer dial survives timeout teardown errors and retries", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kepos-peer-dial-timeout-"));
  const stateDir = path.join(root, "peer");
  let peer: RunningPeer | undefined;
  const streams: DhtStream[] = [];
  const retryReleases: Array<() => void> = [];
  const observations: Array<Record<string, unknown>> = [];
  let now = 10_000;
  let wakeListener: (() => void) | undefined;
  try {
    await setupPeer({ stateDir });
    const dht = createFakeDht() as DhtNode & {
      on: (event: string, listener: () => void) => DhtNode;
      off: (event: string, listener: () => void) => DhtNode;
    };
    dht.on = (event, listener) => {
      if (event === "wakeup") wakeListener = listener;
      return dht;
    };
    dht.off = (event, listener) => {
      if (event === "wakeup" && wakeListener === listener)
        wakeListener = undefined;
      return dht;
    };
    dht.connect = () => {
      const stream = createUnconnectedDhtStream("66".repeat(32));
      streams.push(stream);
      return stream;
    };
    peer = await startPeer({
      stateDir,
      config: parsePeerConfig({
        gateway: { port: 0 },
        peers: [
          { label: "remote", publicKey: "66".repeat(32), connection: "dial" },
        ],
        services: [],
        bindings: [],
      }),
      dht,
      now: () => now,
      connectTimeoutMs: 1,
      sleep: () => new Promise((resolve) => retryReleases.push(resolve)),
      observe: (observation) => observations.push(observation),
      log: () => undefined,
    });
    await waitFor(() => {
      const connection = peer?.status().connections[0];
      return (
        retryReleases.length === 1 &&
        connection?.status === "reconnecting" &&
        connection.error === "Peer connection timed out after 1ms"
      );
    });
    now = 20_000;
    wakeListener?.();
    now = 20_250;
    retryReleases.shift()?.();
    await waitFor(() => {
      const connection = peer?.status().connections[0];
      return (
        streams.length === 2 &&
        retryReleases.length === 1 &&
        connection?.status === "reconnecting" &&
        connection.error === "Peer connection timed out after 1ms"
      );
    });
    assert.equal(streams.length, 2);
    assert.equal(peer?.status().state, "running");
    assert.ok(streams.every((stream) => stream.destroyed));
    const retries = observations.filter(
      (event) => event.event === "outer.retry",
    );
    const retry = retries[0];
    assert.deepEqual(
      {
        attempt: retry?.attempt,
        delayMs: retry?.delayMs,
        errorCategory: retry?.errorCategory,
      },
      { attempt: 1, delayMs: 100, errorCategory: "timeout" },
    );
    assert.equal(
      retry?.outerId,
      observations.find((event) => event.event === "outer.attempt")?.outerId,
    );
    assert.deepEqual(
      observations.find((event) => event.event === "peer.wakeup"),
      {
        component: "kepos",
        timestamp: "1970-01-01T00:00:20.000Z",
        elapsedMs: 10_000,
        role: "peer",
        route: "auto",
        event: "peer.wakeup",
        wakeEpoch: 1,
        dht: {
          punches: { consistent: 0, random: 0, open: 0 },
          relaying: { attempts: 0, successes: 0, aborts: 0 },
        },
      },
    );
    assert.deepEqual(
      {
        wakeEpoch: retries[1]?.wakeEpoch,
        sinceWakeMs: retries[1]?.sinceWakeMs,
      },
      { wakeEpoch: 1, sinceWakeMs: 250 },
    );
  } finally {
    await peer?.stop().catch(() => undefined);
    for (const release of retryReleases.splice(0)) release();
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

async function closeUdp(
  socket: import("node:dgram").Socket | undefined,
): Promise<void> {
  if (!socket) return;
  await new Promise<void>((resolve) => {
    try {
      socket.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

async function bindUdpSocket(socket: Socket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      socket.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      socket.off("error", onError);
      resolve();
    };
    socket.once("error", onError);
    socket.once("listening", onListening);
    socket.bind(0, "127.0.0.1");
  });
}

function sendUdpDatagram(
  socket: Socket,
  port: number,
  payload: Uint8Array,
  timeoutMs = 2_000,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error("UDP datagram exchange timed out"));
    }, timeoutMs);
    const onMessage = (message: Buffer): void => {
      clearTimeout(timer);
      resolve(message);
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

function readStream(stream: import("node:stream").Duplex): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer | Uint8Array) =>
      chunks.push(Buffer.from(chunk)),
    );
    stream.once("error", reject);
    stream.once("end", () => resolve(Buffer.concat(chunks)));
    stream.once("close", () => resolve(Buffer.concat(chunks)));
  });
}

function requestTcp(port: number, payload: Buffer): Promise<Buffer> {
  return requestSocket({ port }, payload);
}

function requestUnix(socketPath: string, payload: Buffer): Promise<Buffer> {
  return requestSocket({ path: socketPath }, payload);
}

function requestHttp(port: number, requestPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: requestPath,
        headers: { authorization: "Bearer forged" },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", () =>
          resolve(Buffer.concat(chunks).toString("utf8")),
        );
      },
    );
    request.once("error", reject);
    request.end();
  });
}

function requestGateway(port: number, serviceId: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port,
        headers: { host: `${serviceId}.localhost:${port}` },
      },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode ?? 0));
      },
    );
    request.once("error", reject);
    request.end();
  });
}

function requestGatewayBody(
  port: number,
  serviceId: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port,
        headers: { host: `${serviceId}.localhost:${port}` },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
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

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for canonical peer state");
}

function delay(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function createUnconnectedDhtStream(remotePublicKey: string): DhtStream {
  const stream = new Duplex({
    read: () => undefined,
    write: (_chunk, _encoding, callback) => callback(),
  }) as DhtStream;
  stream.remotePublicKey = Buffer.from(remotePublicKey, "hex");
  return stream;
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
