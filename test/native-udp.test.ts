import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createSocket, type Socket as UdpSocket } from "node:dgram";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, createServer, type Server } from "node:net";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { test } from "node:test";

import {
  decodeUdpEnvelope,
  decodeUdpFragment,
  encodeUdpDataEnvelopes,
  encodeUdpEnvelope,
  UdpDatagramReassembler,
  UDP_CARRIER_FRAGMENT_PAYLOAD_BYTES,
  UDP_FLOW_ID_BYTES,
  UDP_MAX_PAYLOAD_BYTES,
  createUdpPublisherForwarder,
  createUdpSubscriberTransport,
} from "../src/mux/udp.js";
import { createAndroidRegistrySnapshot } from "../src/android/services.js";
import type { HomeRegistry } from "../src/home/registry.js";
import { createServicePresentations } from "../src/runtime/service-handlers.js";
import { parseSubscriberService } from "../src/cli/options.js";
import {
  setupPublisher,
} from "../src/state/publisher.js";
import {
  setSubscriberPublisher,
  setupSubscriber,
} from "../src/state/subscriber.js";
import {
  startPublisher,
  type PublisherRuntimePolicy,
} from "../src/runtime/publisher.js";
import { startSubscriber } from "../src/runtime/subscriber.js";
import { listenSubscriberUdpService } from "../src/runtime/udp.js";

const require = createRequire(import.meta.url);
const createHyperDhtTestnet = require("hyperdht/testnet") as (
  size: number,
) => Promise<{
  bootstrap: Array<{ host: string; port: number }>;
  destroy: () => Promise<void>;
}>;

class FakeOuter {
  peer?: FakeOuter;
  rawStream: unknown = { send: () => true };
  destroyed = false;
  private readonly listeners = new Map<string, Set<(...args: any[]) => void>>();

  on(event: string, listener: (...args: any[]) => void): this {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  off(event: string, listener: (...args: any[]) => void): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  removeListener(event: string, listener: (...args: any[]) => void): this {
    return this.off(event, listener);
  }

  emit(event: string, ...args: any[]): boolean {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
    return true;
  }

  send(message: Uint8Array): boolean {
    this.peer?.emit("message", message);
    return true;
  }

  close(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit("close");
  }
}

function waitFor(
  predicate: () => boolean,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = (): void => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error("timed out waiting for UDP runtime state"));
        return;
      }
      setTimeout(check, 10).unref();
    };
    check();
  });
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
  timeoutMs = 2_000,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error("UDP exchange timed out"));
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

async function startUdpEcho(
  prefix: string,
): Promise<{ socket: UdpSocket; port: number; messages: Buffer[] }> {
  const socket = await bindUdp();
  const messages: Buffer[] = [];
  socket.on("message", (message, remote) => {
    messages.push(Buffer.from(message));
    const reply = message.byteLength > 1_000
      ? Buffer.from(message)
      : Buffer.concat([Buffer.from(prefix), message]);
    socket.send(reply, remote.port, remote.address);
  });
  return { socket, port: udpPort(socket), messages };
}

async function startTcpEcho(): Promise<{ server: Server; port: number }> {
  const server = createServer((socket) => {
    socket.on("data", (chunk) => socket.write(Buffer.concat([
      Buffer.from("tcp:", "utf8"),
      typeof chunk === "string" ? Buffer.from(chunk) : chunk,
    ])));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("TCP echo server did not expose an address");
  }
  return { server, port: address.port };
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server?.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

test("UDP envelopes preserve bounded datagrams and reject malformed input", () => {
  assert.equal(UDP_MAX_PAYLOAD_BYTES, 1_200);
  assert.equal(UDP_CARRIER_FRAGMENT_PAYLOAD_BYTES, 1_000);
  const flowId = Uint8Array.from({ length: UDP_FLOW_ID_BYTES }, (_, index) => index);
  const payload = Uint8Array.from([0, 1, 2, 255]);
  const decoded = decodeUdpEnvelope(
    encodeUdpEnvelope({ type: "data", serviceId: "game", flowId, payload }),
  );
  assert.equal(decoded.type, "data");
  assert.equal(decoded.serviceId, "game");
  assert.deepEqual([...decoded.flowId], [...flowId]);
  assert.deepEqual([...decoded.payload], [...payload]);
  assert.deepEqual(
    [...decodeUdpEnvelope(encodeUdpEnvelope({
      type: "data",
      serviceId: "game",
      flowId,
      payload: new Uint8Array(),
    })).payload],
    [],
  );
  assert.throws(
    () => encodeUdpEnvelope({ type: "data", serviceId: "Game", flowId, payload }),
    /service id/,
  );
  assert.throws(
    () => encodeUdpDataEnvelopes({
      serviceId: "game",
      flowId,
      payload: new Uint8Array(UDP_MAX_PAYLOAD_BYTES + 1),
    }),
    /payload/,
  );
  assert.throws(() => decodeUdpEnvelope(Uint8Array.of(0x4b, 0x55, 1)), /length/);
  const malformed = encodeUdpEnvelope({ type: "data", serviceId: "game", flowId, payload });
  malformed[3] = 99;
  assert.throws(() => decodeUdpEnvelope(malformed), /type/);
});

test("UDP fragments reassemble reordered datagrams and drop incomplete state", () => {
  const flowId = Uint8Array.from({ length: UDP_FLOW_ID_BYTES }, (_, index) => index);
  const payload = Uint8Array.from({ length: UDP_MAX_PAYLOAD_BYTES }, (_, index) => index % 251);
  const encoded = encodeUdpDataEnvelopes({
    serviceId: "game",
    flowId,
    payload,
    messageId: 17,
  });
  assert.equal(encoded.length, 2);
  assert.ok(encoded.every((fragment) => {
    const envelope = decodeUdpEnvelope(fragment);
    return envelope.payload.byteLength <= UDP_CARRIER_FRAGMENT_PAYLOAD_BYTES;
  }));
  const fragments = encoded.map((fragment) =>
    decodeUdpFragment(decodeUdpEnvelope(fragment)),
  );
  let expiry: (() => void) | undefined;
  const drops: string[] = [];
  const reassembler = new UdpDatagramReassembler({
    timeoutMs: 5_000,
    schedule: (_delay, callback) => {
      expiry = callback;
      return () => {
        if (expiry === callback) expiry = undefined;
      };
    },
    onDrop: (reason) => drops.push(reason),
  });
  assert.equal(reassembler.push(fragments[1]!), undefined);
  assert.equal(reassembler.push(fragments[1]!), undefined);
  assert.deepEqual([...reassembler.push(fragments[0]!)!], [...payload]);
  assert.equal(reassembler.push(fragments[0]!), undefined);

  const second = encodeUdpDataEnvelopes({
    serviceId: "game",
    flowId,
    payload: Uint8Array.from({ length: 1_100 }, () => 9),
    messageId: 18,
  }).map((fragment) => decodeUdpFragment(decodeUdpEnvelope(fragment)));
  assert.equal(reassembler.push(second[0]!), undefined);
  expiry?.();
  assert.deepEqual(drops, ["fragment-reassembly-expired"]);
  const later = encodeUdpDataEnvelopes({
    serviceId: "game",
    flowId,
    payload: Uint8Array.from({ length: 1_100 }, () => 7),
    messageId: 19,
  }).map((fragment) => decodeUdpFragment(decodeUdpEnvelope(fragment)));
  assert.equal(reassembler.push(later[1]!), undefined);
  assert.deepEqual(
    [...reassembler.push(later[0]!)!],
    [...Uint8Array.from({ length: 1_100 }, () => 7)],
  );
  reassembler.clear();
});

test("UDP transport latches unsupported and rejected carrier sends", async () => {
  const unsupported = new FakeOuter();
  unsupported.rawStream = {};
  const unsupportedErrors: string[] = [];
  const unsupportedTransport = createUdpSubscriberTransport(unsupported);
  unsupportedTransport.onError((error) => unsupportedErrors.push(error));
  assert.equal(unsupportedTransport.available(), false);
  assert.match(unsupportedErrors[0] ?? "", /unavailable/);
  unsupportedTransport.close();

  const unavailable = new FakeOuter();
  Object.defineProperty(unavailable, "send", { value: () => undefined });
  const unavailableErrors: string[] = [];
  const unavailableTransport = createUdpSubscriberTransport(unavailable);
  unavailableTransport.onError((error) => unavailableErrors.push(error));
  assert.equal((await unavailableTransport.send(Uint8Array.of(1))).ok, false);
  assert.equal(unavailableTransport.available(), false);
  assert.match(unavailableErrors.at(-1) ?? "", /unavailable/);
  unavailableTransport.close();

  const rejected = new FakeOuter();
  Object.defineProperty(rejected, "send", { value: () => false });
  const rejectedErrors: string[] = [];
  const rejectedTransport = createUdpSubscriberTransport(rejected);
  rejectedTransport.onError((error) => rejectedErrors.push(error));
  assert.equal((await rejectedTransport.send(Uint8Array.of(1))).ok, false);
  assert.equal(rejectedTransport.available(), false);
  assert.match(rejectedErrors.at(-1) ?? "", /rejected/);
  rejectedTransport.close();
});

test("desktop presents UDP endpoints without advertising a browser action", () => {
  const registry: HomeRegistry = {
    schemaVersion: 2,
    revision: 1,
    publisher: { displayName: "publisher", publisherKey: "ab".repeat(32) },
    services: [
      { id: "home", name: "Home", kind: "tcp" },
      { id: "farm", name: "Farm", kind: "udp" },
      { id: "ssh", name: "SSH", kind: "tcp" },
    ],
  };
  const missing = createServicePresentations(registry.services, 17_480);
  assert.deepEqual(missing[0], {
    id: "farm",
    name: "Farm",
    access: "udp",
    action: "copy-endpoint",
    icon: "port",
  });
  assert.deepEqual(
    createServicePresentations(registry.services, 17_480, new Map([
      ["farm", { port: 24_642, kind: "udp" }],
    ]))[0],
    {
      id: "farm",
      name: "Farm",
      access: "udp",
      action: "copy-endpoint",
      icon: "port",
      copyText: "127.0.0.1:24642",
    },
  );
  assert.equal(
    createServicePresentations(registry.services, 17_480, new Map([
      ["farm", { port: 24_642, kind: "tcp" }],
    ]))[0]?.copyText,
    undefined,
  );
  assert.deepEqual(
    createAndroidRegistrySnapshot(registry, 17_480).services,
    [],
  );
});

test("CLI UDP service mappings are explicit and keep the two-part TCP default", () => {
  assert.deepEqual(parseSubscriberService("stardew:udp:24642"), {
    id: "stardew",
    kind: "udp",
    localPort: 24_642,
  });
  assert.deepEqual(parseSubscriberService("ssh:2222"), {
    id: "ssh",
    localPort: 2_222,
  });
  assert.throws(
    () => parseSubscriberService("stardew:udp:24642:extra"),
    /id:local-port|id:udp:local-port/,
  );
  assert.throws(
    () => parseSubscriberService("stardew:24642:udp"),
    /id:local-port|id:udp:local-port/,
  );
});

test("unordered UDP transport forwards fixed-target replies and applies ACL before target creation", async () => {
  const subscriberOuter = new FakeOuter();
  const publisherOuter = new FakeOuter();
  subscriberOuter.peer = publisherOuter;
  publisherOuter.peer = subscriberOuter;
  let allowed = false;
  const target = await startUdpEcho("reply:");
  const drops: string[] = [];
  const publisher = createUdpPublisherForwarder(publisherOuter, {
    authorized: () => true,
    serviceAuthorized: () => allowed,
    serviceKind: () => "udp",
    targetPort: () => target.port,
    onDrop: (reason) => drops.push(reason),
  });
  const subscriber = createUdpSubscriberTransport(subscriberOuter);
  const local = await bindUdp();
  const listener = await listenSubscriberUdpService("farm", 0, subscriber);
  // The target is fixed and the publisher forwarder is the only code allowed
  // to create its per-flow socket. The first denied request must not reach it.
  const denied = sendUdp(local, listener.port, Buffer.from("denied"), 100).catch(() => undefined);
  await denied;
  assert.deepEqual(target.messages, []);
  allowed = true;
  assert.equal((await sendUdp(local, listener.port, Buffer.from("hello"))).toString(), "reply:hello");
  assert.deepEqual(target.messages.map((message: Buffer) => message.toString()), ["hello"]);
  assert.equal(publisher.available(), true);
  assert.deepEqual(drops, ["unauthorized-service"]);
  await listener.close();
  publisher.close();
  subscriber.close();
  await closeUdp(local);
  await closeUdp(target.socket);
});

test("UDP publisher replies drop when the shared outbound budget is unavailable", async () => {
  const subscriberOuter = new FakeOuter();
  const publisherOuter = new FakeOuter();
  subscriberOuter.peer = publisherOuter;
  publisherOuter.peer = subscriberOuter;
  const target = await startUdpEcho("reply:");
  const drops: string[] = [];
  const limiter = {
    tryConsume: () => false,
    wait: () => {
      throw new Error("UDP must not queue on the shared rate limiter");
    },
  };
  const publisher = createUdpPublisherForwarder(publisherOuter, {
    authorized: () => true,
    serviceKind: () => "udp",
    targetPort: () => target.port,
    publisherToSubscriberRateLimiter: () => limiter,
    onDrop: (reason) => drops.push(reason),
  });
  const subscriber = createUdpSubscriberTransport(subscriberOuter);
  const local = await bindUdp();
  const listener = await listenSubscriberUdpService("farm", 0, subscriber);
  try {
    await assert.rejects(
      sendUdp(local, listener.port, Buffer.from("drop-me"), 150),
      /timed out/,
    );
    await waitFor(() => target.messages.length === 1);
    assert.deepEqual(drops, ["publisher-rate-limit"]);
  } finally {
    await listener.close();
    publisher.close();
    subscriber.close();
    await closeUdp(local);
    await closeUdp(target.socket);
  }
});

test("real desktop runtime exchanges UDP and TCP over one authenticated outer", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kepos-native-udp-"));
  const testnet = await createHyperDhtTestnet(3);
  const targetA = await startUdpEcho("a:");
  const targetB = await startUdpEcho("b:");
  const tcpTarget = await startTcpEcho();
  let publisher: Awaited<ReturnType<typeof startPublisher>> | undefined;
  let subscriber: Awaited<ReturnType<typeof startSubscriber>> | undefined;
  const outerEvents: string[] = [];
  let localA: UdpSocket | undefined;
  let localB: UdpSocket | undefined;
  let localTcp: ReturnType<typeof import("node:net").createConnection> | undefined;
  try {
    const publisherState = path.join(root, "publisher");
    const subscriberState = path.join(root, "subscriber");
    const publisherIdentity = await setupPublisher({ stateDir: publisherState });
    const subscriberIdentity = await setupSubscriber({ stateDir: subscriberState });
    await setSubscriberPublisher({
      stateDir: subscriberState,
      label: "publisher",
      publisherKey: publisherIdentity.publisherKey,
    });
    const policy: PublisherRuntimePolicy = {
      displayName: "publisher",
      subscribers: [{ publicKey: subscriberIdentity.publicKey, label: "subscriber" }],
      services: [
        { id: "farm-a", name: "Farm A", kind: "udp", targetPort: targetA.port },
        { id: "farm-b", name: "Farm B", kind: "udp", targetPort: targetB.port },
        { id: "echo", name: "Echo", targetPort: tcpTarget.port },
      ],
    };
    publisher = await startPublisher({
      stateDir: publisherState,
      bootstrap: testnet.bootstrap,
      policy,
    });
    subscriber = await startSubscriber({
      stateDir: subscriberState,
      bootstrap: testnet.bootstrap,
      gatewayPort: 0,
      services: [
        { id: "farm-a", kind: "udp", localPort: 0 },
        { id: "farm-b", kind: "udp", localPort: 0 },
        { id: "echo", localPort: 0 },
      ],
      observe: (event) => {
        if (event.event === "outer.connected") outerEvents.push(event.event);
      },
    });
    assert.equal(outerEvents.length, 1);
    localA = await bindUdp();
    localB = await bindUdp();
    const farmA = subscriber.services.find((service) => service.id === "farm-a");
    const farmB = subscriber.services.find((service) => service.id === "farm-b");
    const echo = subscriber.services.find((service) => service.id === "echo");
    assert.ok(farmA && farmB && echo);
    assert.equal(farmA.kind, "udp");
    assert.equal(farmB.kind, "udp");
    assert.equal((await sendUdp(localA, farmA.port, Buffer.from("one"))).toString(), "a:one");
    assert.equal((await sendUdp(localB, farmA.port, Buffer.from("two"))).toString(), "a:two");
    assert.equal((await sendUdp(localA, farmB.port, Buffer.from("three"))).toString(), "b:three");
    const large = Buffer.alloc(1_200, 0x5a);
    assert.deepEqual(await sendUdp(localA, farmA.port, large), large);
    localTcp = createConnection({ host: "127.0.0.1", port: echo.port });
    await once(localTcp, "connect");
    localTcp.write("tcp-payload");
    const [tcpReply] = await once(localTcp, "data");
    assert.equal(Buffer.from(tcpReply).toString(), "tcp:tcp-payload");
  } finally {
    localTcp?.destroy();
    await closeUdp(localA);
    await closeUdp(localB);
    await subscriber?.stop();
    await publisher?.stop();
    await closeServer(tcpTarget.server);
    await closeUdp(targetA.socket);
    await closeUdp(targetB.socket);
    await testnet.destroy();
    await rm(root, { recursive: true, force: true });
  }
});

test("UDP policy revocation, outer replacement, and retained listener recovery are bounded", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kepos-native-udp-recovery-"));
  const testnet = await createHyperDhtTestnet(3);
  const target = await startUdpEcho("ok:");
  let publisher: Awaited<ReturnType<typeof startPublisher>> | undefined;
  let subscriber: Awaited<ReturnType<typeof startSubscriber>> | undefined;
  let local: UdpSocket | undefined;
  try {
    const publisherState = path.join(root, "publisher");
    const subscriberState = path.join(root, "subscriber");
    const publisherIdentity = await setupPublisher({ stateDir: publisherState });
    const subscriberIdentity = await setupSubscriber({ stateDir: subscriberState });
    await setSubscriberPublisher({
      stateDir: subscriberState,
      label: "publisher",
      publisherKey: publisherIdentity.publisherKey,
    });
    const deniedPolicy: PublisherRuntimePolicy = {
      displayName: "publisher",
      subscribers: [{ publicKey: subscriberIdentity.publicKey, label: "subscriber" }],
      services: [{
        id: "farm",
        name: "Farm",
        kind: "udp",
        targetPort: target.port,
        allow: [],
      }],
    };
    publisher = await startPublisher({
      stateDir: publisherState,
      bootstrap: testnet.bootstrap,
      policy: deniedPolicy,
    });
    subscriber = await startSubscriber({
      stateDir: subscriberState,
      bootstrap: testnet.bootstrap,
      gatewayPort: 0,
      services: [{ id: "farm", kind: "udp", localPort: 0 }],
    });
    local = await bindUdp();
    const listener = subscriber.services[0];
    assert.ok(listener);
    await assert.rejects(
      sendUdp(local, listener.port, Buffer.from("denied"), 150),
      /timed out/,
    );
    assert.deepEqual(target.messages, []);

    const allowedPolicy: PublisherRuntimePolicy = {
      ...deniedPolicy,
      services: [{ ...deniedPolicy.services[0]!, allow: [subscriberIdentity.publicKey] }],
    };
    assert.equal(await publisher.applyPolicy(allowedPolicy), true);
    assert.equal((await sendUdp(local, listener.port, Buffer.from("allowed"))).toString(), "ok:allowed");
    const firstGeneration = subscriber.status().connectionGeneration;
    assert.equal(subscriber.invalidateConnection(firstGeneration, "test-reconnect"), true);
    await waitFor(() => subscriber?.status().connection === "connected" && subscriber.status().connectionGeneration > firstGeneration);
    assert.equal(subscriber.services[0]?.port, listener.port);
    assert.equal((await sendUdp(local, listener.port, Buffer.from("recovered"))).toString(), "ok:recovered");

    const revokedPolicy: PublisherRuntimePolicy = {
      ...allowedPolicy,
      services: [{ ...allowedPolicy.services[0]!, allow: [] }],
    };
    assert.equal(await publisher.applyPolicy(revokedPolicy), true);
    await assert.rejects(
      sendUdp(local, listener.port, Buffer.from("revoked"), 150),
      /timed out/,
    );
    assert.deepEqual(
      target.messages.map((message: Buffer) => message.toString()),
      ["allowed", "recovered"],
    );
  } finally {
    await closeUdp(local);
    await subscriber?.stop();
    await publisher?.stop();
    await closeUdp(target.socket);
    await testnet.destroy();
    await rm(root, { recursive: true, force: true });
  }
});
