import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import {
  createServer as createHttpServer,
  request,
  type Server as HttpServer,
} from "node:http";
import type { Duplex } from "node:stream";
import {
  createConnection,
  createServer,
  type Server,
} from "node:net";
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
import {
  loadSubscriberConnectionState,
  loadSubscriberState,
} from "../src/state/subscriber.js";
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
  authorization?: string | string[],
  expectedStatus = 200,
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const headers: Record<string, string | string[]> = { host };
    if (authorization !== undefined) headers.authorization = authorization;
    const outgoing = request({
      hostname: "127.0.0.1",
      port,
      path: requestPath,
      headers,
    });
    outgoing.once("response", (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.once("end", () => {
        if (response.statusCode !== expectedStatus) {
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

interface RawHttpResponse {
  status: number;
  body: Buffer;
}

function persistentResponseReader(
  socket: ReturnType<typeof createConnection>,
): () => Promise<RawHttpResponse> {
  let buffered = Buffer.alloc(0);
  let waiter:
    | {
        resolve: (response: RawHttpResponse) => void;
        reject: (error: Error) => void;
      }
    | undefined;
  let closedError: Error | undefined;

  socket.on("data", (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    pump();
  });
  socket.on("error", (error) => {
    closedError = error instanceof Error ? error : new Error(String(error));
    if (waiter) {
      const current = waiter;
      waiter = undefined;
      current.reject(closedError);
    }
  });
  socket.on("close", () => {
    if (waiter) {
      const current = waiter;
      waiter = undefined;
      current.reject(closedError ?? new Error("HTTP response socket closed"));
    }
  });

  return () => {
    if (closedError) return Promise.reject(closedError);
    return new Promise<RawHttpResponse>((resolve, reject) => {
      waiter = { resolve, reject };
      pump();
    });
  };

  function pump(): void {
    if (!waiter) return;
    const headerEnd = buffered.indexOf(Buffer.from("\r\n\r\n"));
    if (headerEnd === -1) return;
    const header = buffered.subarray(0, headerEnd).toString("latin1");
    const lines = header.split("\r\n");
    const statusMatch = /^HTTP\/1\.1 (\d{3}) /.exec(lines.shift() ?? "");
    const lengthLine = lines.find((line) => /^content-length:/i.test(line));
    const lengthMatch = /^content-length:\s*([0-9]+)$/i.exec(lengthLine ?? "");
    if (!statusMatch || !lengthMatch) {
      const current = waiter;
      waiter = undefined;
      current.reject(new Error("target response has invalid test framing"));
      return;
    }
    const length = Number(lengthMatch[1]);
    const bodyStart = headerEnd + 4;
    if (buffered.byteLength < bodyStart + length) return;
    const current = waiter;
    waiter = undefined;
    const body = Buffer.from(buffered.subarray(bodyStart, bodyStart + length));
    buffered = buffered.subarray(bodyStart + length);
    current.resolve({ status: Number(statusMatch[1]), body });
  }
}

async function writeSplit(
  socket: ReturnType<typeof createConnection>,
  input: Uint8Array,
  chunkSize: number,
): Promise<void> {
  for (let offset = 0; offset < input.byteLength; offset += chunkSize) {
    const chunk = input.subarray(offset, offset + chunkSize);
    if (!socket.write(chunk)) await once(socket, "drain");
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function readRawHead(
  socket: ReturnType<typeof createConnection>,
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf(Buffer.from("\r\n\r\n"));
      if (end === -1) return;
      socket.off("data", onData);
      resolve(Buffer.from(buffered.subarray(0, end + 4)));
    };
    socket.on("data", onData);
    socket.once("error", reject);
    socket.once("close", () => reject(new Error("raw HTTP socket closed")));
  });
}

async function readExactly(
  socket: ReturnType<typeof createConnection>,
  length: number,
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.byteLength < length) return;
      socket.off("data", onData);
      resolve(Buffer.from(buffered.subarray(0, length)));
    };
    socket.on("data", onData);
    socket.once("error", reject);
    socket.once("close", () => reject(new Error("raw WebSocket socket closed")));
  });
}

function waitForSocketClose(
  socket: ReturnType<typeof createConnection>,
  message: string,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onClose = (): void => {
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(() => {
      socket.off("close", onClose);
      reject(new Error(message));
    }, 2_000);
    socket.once("close", onClose);
  });
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
    const status =
      request.url === "/rest/unauthorized"
        ? 401
        : request.url === "/rest/forbidden"
          ? 403
          : 200;
    response.writeHead(status, {
      "content-type": "audio/flac",
      "x-request-path": request.url ?? "/",
    });
    response.end(status === 200 ? Buffer.alloc(64 * 1024, 7) : `HTTP ${status}`);
  });
  const navidromeAuthorizations: string[][] = [];
  navidromeServer.on("request", (request) => {
    const values: string[] = [];
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      if (request.rawHeaders[index]?.toLowerCase() !== "authorization") continue;
      const value = request.rawHeaders[index + 1];
      if (value !== undefined) values.push(value);
    }
    navidromeAuthorizations.push(values);
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
        {
          id: "navidrome",
          name: "Navidrome",
          kind: "http",
          targetPort: navidromePort,
        },
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

    const [
      healthResponse,
      audioResponse,
      podResponse,
      unauthorizedResponse,
      forbiddenResponse,
      sshResponse,
    ] = await Promise.all([
      fetch(`${subscriber.home.url}/healthz`),
      fetch(
        `http://navidrome.localhost:${subscriber.home.port}/rest/stream`,
      ),
      requestWithHost(
        subscriber.home.port,
        "navidrome.kepos.internal",
        "/rest/stream",
        ["Bearer forged", "Basic forged"],
      ),
      requestWithHost(
        subscriber.home.port,
        "navidrome.kepos.internal",
        "/rest/unauthorized",
        "Bearer forged",
        401,
      ),
      requestWithHost(
        subscriber.home.port,
        "navidrome.kepos.internal",
        "/rest/forbidden",
        "Bearer forged",
        403,
      ),
      exchangeTcp(
        ssh.port,
        `Authorization: Kepos ${subscriberSetup.publicKey}\r\n`,
      ),
    ]);
    assert.equal(healthResponse.status, 200);
    assert.equal(audioResponse.status, 200);
    assert.equal((await audioResponse.arrayBuffer()).byteLength, 64 * 1024);
    assert.equal(podResponse.byteLength, 64 * 1024);
    assert.equal(unauthorizedResponse.toString(), "HTTP 401");
    assert.equal(forbiddenResponse.toString(), "HTTP 403");
    assert.equal(
      sshResponse,
      `ssh:Authorization: Kepos ${subscriberSetup.publicKey}\r\n`,
    );
    assert.ok(navidromeAuthorizations.length >= 2);
    for (const authorization of navidromeAuthorizations) {
      assert.deepEqual(authorization, [`Kepos ${subscriberSetup.publicKey}`]);
    }
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

test("forwards fragmented persistent HTTP/1.1 requests with per-request identity", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kepos-mux-http-persistent-"));
  const subscriberState = path.join(root, "subscriber");
  const publisherState = path.join(root, "publisher");
  interface TargetRequest {
    authorization: string[];
    body: Buffer;
  }
  const targetRequests: TargetRequest[] = [];
  const target = createHttpServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      const authorizations: string[] = [];
      for (let index = 0; index < request.rawHeaders.length; index += 2) {
        if (request.rawHeaders[index]?.toLowerCase() !== "authorization") {
          continue;
        }
        const value = request.rawHeaders[index + 1];
        if (value !== undefined) authorizations.push(value);
      }
      const body = Buffer.concat(chunks);
      targetRequests.push({ authorization: authorizations, body });
      const responseBody = Buffer.from(
        `response-${targetRequests.length}-first/response-${targetRequests.length}-last`,
      );
      response.writeHead(200, {
        Connection: "keep-alive",
        "Content-Length": responseBody.byteLength,
        "Content-Type": "text/plain",
      });
      const splitAt = responseBody.indexOf(Buffer.from("/"));
      response.write(responseBody.subarray(0, splitAt));
      setImmediate(() => response.end(responseBody.subarray(splitAt)));
    });
  });
  let testnet: HyperDhtTestnet | undefined;
  let publisher: RunningPublisher | undefined;
  let subscriber: RunningSubscriber | undefined;
  let client: ReturnType<typeof createConnection> | undefined;
  let malformedClient: ReturnType<typeof createConnection> | undefined;
  let testError: unknown;

  try {
    const targetPort = await listen(target);
    const subscriberSetup = await setupSubscriber({ stateDir: subscriberState });
    const publisherSetup = await setupPublisher({
      stateDir: publisherState,
      displayName: "kosmos",
      subscriberPublicKeys: [subscriberSetup.publicKey],
      services: [
        {
          id: "navidrome",
          name: "Navidrome",
          kind: "http",
          targetPort,
        },
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
    });
    subscriber = await startSubscriber({
      stateDir: subscriberState,
      bootstrap: testnet.bootstrap,
      gatewayPort: 0,
      gatewayDomain: "kepos.internal",
      services: [],
      log: noLog,
    });

    client = createConnection({ host: "127.0.0.1", port: subscriber.home.port });
    await once(client, "connect");
    const readResponse = persistentResponseReader(client);
    const firstBody = Buffer.from("first-body");
    const firstRequest = Buffer.from(
      `POST /first HTTP/1.1\r\nHost: navidrome.kepos.internal\r\nAuthorization: Bearer forged\r\naUtHoRiZaTiOn: Basic forged\r\nConnection: keep-alive\r\nContent-Length: ${firstBody.byteLength}\r\n\r\n${firstBody.toString("latin1")}`,
      "latin1",
    );
    await writeSplit(client, firstRequest, 5);
    const firstResponse = await readResponse();
    assert.equal(firstResponse.status, 200);
    assert.equal(
      firstResponse.body.toString(),
      "response-1-first/response-1-last",
    );

    const secondBody = Buffer.from("chunked-body");
    const secondRequest = Buffer.from(
      `POST /second HTTP/1.1\r\nHost: navidrome.kepos.internal\r\nAuthorization: forged-second\r\nConnection: keep-alive\r\nTransfer-Encoding: chunked\r\n\r\n${secondBody.byteLength.toString(16)}\r\n${secondBody.toString("latin1")}\r\n0\r\n\r\n`,
      "latin1",
    );
    await writeSplit(client, secondRequest, 2);
    const secondResponse = await readResponse();
    assert.equal(secondResponse.status, 200);
    assert.equal(
      secondResponse.body.toString(),
      "response-2-first/response-2-last",
    );

    assert.deepEqual(targetRequests, [
      {
        authorization: [`Kepos ${subscriberSetup.publicKey}`],
        body: firstBody,
      },
      {
        authorization: [`Kepos ${subscriberSetup.publicKey}`],
        body: secondBody,
      },
    ]);

    const cleanClose = waitForSocketClose(
      client,
      "clean persistent request did not close",
    );
    client.end();
    await cleanClose;

    malformedClient = createConnection({
      host: "127.0.0.1",
      port: subscriber.home.port,
    });
    malformedClient.on("error", () => undefined);
    await once(malformedClient, "connect");
    const readMalformedResponse = persistentResponseReader(malformedClient);
    await writeSplit(
      malformedClient,
      Buffer.from(
        "GET /before-malformed HTTP/1.1\r\nHost: navidrome.kepos.internal\r\nConnection: keep-alive\r\n\r\n",
        "latin1",
      ),
      4,
    );
    const beforeMalformedResponse = await readMalformedResponse();
    assert.equal(beforeMalformedResponse.status, 200);
    assert.equal(
      beforeMalformedResponse.body.toString(),
      "response-3-first/response-3-last",
    );
    assert.deepEqual(targetRequests[2], {
      authorization: [`Kepos ${subscriberSetup.publicKey}`],
      body: Buffer.alloc(0),
    });

    const malformedSecond = Buffer.from(
      "GET /malformed HTTP/1.1\r\nHost: navidrome.kepos.internal\r\nContent-Length: 1\r\nContent-Length: 2\r\nAuthorization: forged-third\r\n\r\nX",
      "latin1",
    );
    const malformedClose = waitForSocketClose(
      malformedClient,
      "malformed persistent request stayed open",
    );
    await writeSplit(malformedClient, malformedSecond, 3);
    await malformedClose;
    assert.equal(targetRequests.length, 3);
  } catch (error) {
    testError = error;
  }

  client?.destroy();
  malformedClient?.destroy();
  const cleanup = await Promise.allSettled([
    subscriber?.stop(),
    publisher?.stop(),
    closeServer(target),
    testnet?.destroy(),
    rm(root, { recursive: true, force: true }),
  ]);
  const cleanupErrors = cleanup
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason as unknown);
  if (testError || cleanupErrors.length > 0) {
    throw new AggregateError(
      [testError, ...cleanupErrors].filter((error) => error !== undefined),
      "persistent HTTP/1.1 test or cleanup failed",
    );
  }
});

test("delivers a target response after an HTTP client half-closes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kepos-mux-http-half-close-"));
  const subscriberState = path.join(root, "subscriber");
  const publisherState = path.join(root, "publisher");
  const targetSockets = new Set<Duplex>();
  let targetRequest = "";
  const responseBody = "final-after-fin";
  const target = createServer({ allowHalfOpen: true }, (socket) => {
    targetSockets.add(socket);
    socket.once("close", () => targetSockets.delete(socket));
    socket.on("error", () => undefined);
    socket.setEncoding("latin1");
    socket.on("data", (chunk) => {
      targetRequest += chunk;
    });
    socket.once("end", () => {
      setImmediate(() => {
        if (socket.destroyed) return;
        socket.end(
          `HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(responseBody)}\r\nConnection: close\r\n\r\n${responseBody}`,
        );
      });
    });
  });
  let testnet: HyperDhtTestnet | undefined;
  let publisher: RunningPublisher | undefined;
  let subscriber: RunningSubscriber | undefined;
  let testError: unknown;

  try {
    const targetPort = await listen(target);
    const subscriberSetup = await setupSubscriber({ stateDir: subscriberState });
    const publisherSetup = await setupPublisher({
      stateDir: publisherState,
      displayName: "kosmos",
      subscriberPublicKeys: [subscriberSetup.publicKey],
      services: [
        {
          id: "half-close",
          name: "Half close",
          kind: "http",
          targetPort,
        },
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
    });
    subscriber = await startSubscriber({
      stateDir: subscriberState,
      bootstrap: testnet.bootstrap,
      gatewayPort: 0,
      gatewayDomain: "kepos.internal",
      services: [],
      log: noLog,
    });

    const response = await exchangeTcp(
      subscriber.home.port,
      "GET /after-fin HTTP/1.1\r\nHost: half-close.kepos.internal\r\nAuthorization: Bearer forged\r\n\r\n",
    );
    assert.equal(
      response,
      `HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(responseBody)}\r\nConnection: close\r\n\r\n${responseBody}`,
    );
    assert.match(
      targetRequest,
      new RegExp(`Authorization: Kepos ${subscriberSetup.publicKey}\\r\\n`),
    );
    assert.equal(targetRequest.includes("Bearer forged"), false);
  } catch (error) {
    testError = error;
  }

  for (const socket of targetSockets) socket.destroy();
  const cleanup = await Promise.allSettled([
    subscriber?.stop(),
    publisher?.stop(),
    closeServer(target),
    testnet?.destroy(),
    rm(root, { recursive: true, force: true }),
  ]);
  const cleanupErrors = cleanup
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason as unknown);
  if (testError || cleanupErrors.length > 0) {
    throw new AggregateError(
      [testError, ...cleanupErrors].filter((error) => error !== undefined),
      "HTTP half-close test or cleanup failed",
    );
  }
});

test("authenticates a split WebSocket Upgrade and then forwards opaque bytes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kepos-mux-websocket-"));
  const subscriberState = path.join(root, "subscriber");
  const publisherState = path.join(root, "publisher");
  const authorizations: string[][] = [];
  const upgradeHeads: Buffer[] = [];
  const targetSockets = new Set<Duplex>();
  const target = createHttpServer();
  target.on("upgrade", (request, socket, head) => {
    const values: string[] = [];
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      if (request.rawHeaders[index]?.toLowerCase() !== "authorization") continue;
      const value = request.rawHeaders[index + 1];
      if (value !== undefined) values.push(value);
    }
    authorizations.push(values);
    upgradeHeads.push(Buffer.from(head));
    targetSockets.add(socket);
    socket.once("close", () => targetSockets.delete(socket));
    socket.on("data", (chunk) => socket.write(chunk));
    const response = Buffer.from(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
      "latin1",
    );
    socket.write(response.subarray(0, 23));
    setImmediate(() => socket.write(response.subarray(23)));
  });
  let testnet: HyperDhtTestnet | undefined;
  let publisher: RunningPublisher | undefined;
  let subscriber: RunningSubscriber | undefined;
  let client: ReturnType<typeof createConnection> | undefined;
  let testError: unknown;

  try {
    const targetPort = await listen(target);
    const subscriberSetup = await setupSubscriber({ stateDir: subscriberState });
    const publisherSetup = await setupPublisher({
      stateDir: publisherState,
      displayName: "kosmos",
      subscriberPublicKeys: [subscriberSetup.publicKey],
      services: [
        {
          id: "websocket",
          name: "WebSocket",
          kind: "http",
          targetPort,
        },
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
    });
    subscriber = await startSubscriber({
      stateDir: subscriberState,
      bootstrap: testnet.bootstrap,
      gatewayPort: 0,
      gatewayDomain: "kepos.internal",
      services: [],
      log: noLog,
    });

    client = createConnection({ host: "127.0.0.1", port: subscriber.home.port });
    await once(client, "connect");
    const handshake = Buffer.from(
      "GET /socket HTTP/1.1\r\nHost: websocket.kepos.internal\r\nUpgrade: WebSocket\r\nConnection: Upgrade\r\nAuthorization: Bearer forged\r\naUtHoRiZaTiOn: Basic forged\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGVzdC1rZXk=\r\n\r\n",
      "latin1",
    );
    await writeSplit(client, handshake, 4);
    const responseHead = await readRawHead(client);
    assert.match(responseHead.toString("latin1"), /^HTTP\/1\.1 101 /);
    await waitFor(
      () => authorizations.length === 1,
      "WebSocket target did not receive the opening handshake",
    );
    assert.deepEqual(authorizations, [[`Kepos ${subscriberSetup.publicKey}`]]);
    assert.equal(upgradeHeads[0]?.byteLength, 0);

    const binary = Buffer.from([0, 255, 1, 128, 2, 42, 0, 17]);
    const echoed = readExactly(client, binary.byteLength);
    await writeSplit(client, binary, 2);
    assert.deepEqual(await echoed, binary);
  } catch (error) {
    testError = error;
  }

  client?.destroy();
  for (const socket of targetSockets) socket.destroy();
  const cleanup = await Promise.allSettled([
    subscriber?.stop(),
    publisher?.stop(),
    closeServer(target),
    testnet?.destroy(),
    rm(root, { recursive: true, force: true }),
  ]);
  const cleanupErrors = cleanup
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason as unknown);
  if (testError || cleanupErrors.length > 0) {
    throw new AggregateError(
      [testError, ...cleanupErrors].filter((error) => error !== undefined),
      "WebSocket integration test or cleanup failed",
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

test("service allowlists restrict channels and subscriber registries", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kepos-service-acl-"));
  const publisherState = path.join(root, "publisher");
  const allowedState = path.join(root, "allowed");
  const deniedState = path.join(root, "denied");
  let targetRequests = 0;
  const target = createServer({ allowHalfOpen: true }, (socket) => {
    socket.once("data", (payload) => {
      targetRequests++;
      socket.end(`dagger:${payload.toString()}`);
    });
  });
  let testnet: HyperDhtTestnet | undefined;
  let publisher: RunningPublisher | undefined;
  let allowed: RunningSubscriber | undefined;
  let denied: RunningSubscriber | undefined;

  try {
    const targetPort = await listen(target);
    const [allowedSetup, deniedSetup] = await Promise.all([
      setupSubscriber({ stateDir: allowedState }),
      setupSubscriber({ stateDir: deniedState }),
    ]);
    const publisherSetup = await setupPublisher({
      stateDir: publisherState,
      displayName: "kosmos",
      subscriberPublicKeys: [allowedSetup.publicKey, deniedSetup.publicKey],
      services: [],
    });
    await Promise.all([
      setSubscriberPublisher({
        stateDir: allowedState,
        label: "kosmos",
        publisherKey: publisherSetup.publisherKey,
      }),
      setSubscriberPublisher({
        stateDir: deniedState,
        label: "kosmos",
        publisherKey: publisherSetup.publisherKey,
      }),
    ]);

    testnet = await createHyperDhtTestnet(3);
    publisher = await startPublisher({
      stateDir: publisherState,
      bootstrap: testnet.bootstrap,
      log: noLog,
      policy: {
        displayName: "kosmos",
        allow: [allowedSetup.publicKey, deniedSetup.publicKey],
        services: [
          {
            id: "dagger",
            name: "Dagger",
            targetPort,
            allow: [allowedSetup.publicKey],
          },
        ],
      },
    });
    [allowed, denied] = await Promise.all([
      startSubscriber({
        stateDir: allowedState,
        bootstrap: testnet.bootstrap,
        gatewayPort: 0,
        services: [{ id: "dagger", localPort: 0 }],
        log: noLog,
      }),
      startSubscriber({
        stateDir: deniedState,
        bootstrap: testnet.bootstrap,
        gatewayPort: 0,
        services: [{ id: "dagger", localPort: 0 }],
        log: noLog,
      }),
    ]);

    const [allowedRegistry, deniedRegistry] = await Promise.all([
      fetch(`${allowed.home.url}/.well-known/kepos/services.json`).then(
        (response) =>
          response.json() as Promise<{
            services: Array<{ id: string }>;
          }>,
      ),
      fetch(`${denied.home.url}/.well-known/kepos/services.json`).then(
        (response) =>
          response.json() as Promise<{
            services: Array<{ id: string }>;
          }>,
      ),
    ]);
    assert.deepEqual(
      allowedRegistry.services.map(({ id }) => id),
      ["home", "dagger"],
    );
    assert.deepEqual(
      deniedRegistry.services.map(({ id }) => id),
      ["home"],
    );

    const dagger = allowed.services.find((service) => service.id === "dagger");
    const deniedDagger = denied.services.find(
      (service) => service.id === "dagger",
    );
    assert.ok(dagger);
    assert.ok(deniedDagger);
    assert.equal(await exchangeTcp(dagger.port, "version"), "dagger:version");
    assert.equal(await exchangeTcp(deniedDagger.port, "version"), "");
    assert.equal(targetRequests, 1);
  } finally {
    await Promise.allSettled([
      allowed?.stop(),
      denied?.stop(),
      publisher?.stop(),
      closeServer(target),
      testnet?.destroy(),
      rm(root, { recursive: true, force: true }),
    ]);
  }
});

test("publisher policy reload preserves unaffected subscribers and drains services", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kepos-policy-reload-"));
  const publisherState = path.join(root, "publisher");
  const allowedState = path.join(root, "allowed");
  const removedState = path.join(root, "removed");
  const targetA = createServer({ allowHalfOpen: true }, (socket) => {
    socket.on("data", (payload) => socket.write(`target-a:${payload}`));
    socket.on("end", () => socket.end());
  });
  const targetB = createServer({ allowHalfOpen: true }, (socket) => {
    socket.on("data", (payload) => socket.write(`target-b:${payload}`));
    socket.on("end", () => socket.end());
  });
  let testnet: HyperDhtTestnet | undefined;
  let publisher: RunningPublisher | undefined;
  let allowed: RunningSubscriber | undefined;
  let removed: RunningSubscriber | undefined;
  let existing: ReturnType<typeof createConnection> | undefined;

  try {
    const [allowedSetup, removedSetup] = await Promise.all([
      setupSubscriber({ stateDir: allowedState }),
      setupSubscriber({ stateDir: removedState }),
    ]);
    const publisherSetup = await setupPublisher({
      stateDir: publisherState,
      displayName: "original",
      subscriberPublicKeys: [allowedSetup.publicKey, removedSetup.publicKey],
      services: [],
    });
    await Promise.all([
      setSubscriberPublisher({
        stateDir: allowedState,
        label: "original",
        publisherKey: publisherSetup.publisherKey,
      }),
      setSubscriberPublisher({
        stateDir: removedState,
        label: "original",
        publisherKey: publisherSetup.publisherKey,
      }),
    ]);
    const [targetAPort, targetBPort] = await Promise.all([
      listen(targetA),
      listen(targetB),
    ]);
    testnet = await createHyperDhtTestnet(3);
    publisher = await startPublisher({
      stateDir: publisherState,
      bootstrap: testnet.bootstrap,
      log: noLog,
      policy: {
        displayName: "original",
        allow: [allowedSetup.publicKey, removedSetup.publicKey],
        services: [
          {
            id: "echo",
            name: "Echo",
            targetPort: targetAPort,
            allow: [allowedSetup.publicKey, removedSetup.publicKey],
          },
        ],
      },
    });
    const homeUrl = publisher.home.url;
    assert.equal(publisher.publisherKey, publisherSetup.publisherKey);
    assert.equal(
      await publisher.applyPolicy({
        displayName: "original",
        allow: [allowedSetup.publicKey, removedSetup.publicKey],
        services: [
          {
            id: "echo",
            name: "Echo",
            targetPort: targetAPort,
            allow: [allowedSetup.publicKey, removedSetup.publicKey],
          },
        ],
      }),
      false,
    );
    assert.equal(publisher.home.url, homeUrl);
    [allowed, removed] = await Promise.all([
      startSubscriber({
        stateDir: allowedState,
        bootstrap: testnet.bootstrap,
        gatewayPort: 0,
        serviceAcquisitionTimeoutMs: 500,
        services: [{ id: "echo", localPort: 0 }],
        log: noLog,
      }),
      startSubscriber({
        stateDir: removedState,
        bootstrap: testnet.bootstrap,
        gatewayPort: 0,
        serviceAcquisitionTimeoutMs: 500,
        services: [{ id: "echo", localPort: 0 }],
        log: noLog,
      }),
    ]);
    const allowedEcho = allowed.services.find(({ id }) => id === "echo");
    const removedEcho = removed.services.find(({ id }) => id === "echo");
    assert.ok(allowedEcho);
    assert.ok(removedEcho);

    existing = createConnection({ host: "127.0.0.1", port: allowedEcho.port });
    await once(existing, "connect");
    existing.write("before");
    const [before] = await once(existing, "data");
    assert.equal(before.toString(), "target-a:before");

    const registryUrl = `${allowed.home.url}/.well-known/kepos/services.json`;
    const initialRegistryResponse = await fetch(registryUrl);
    const initialEtag = initialRegistryResponse.headers.get("etag");
    assert.ok(initialEtag);
    await initialRegistryResponse.json();

    assert.equal(
      await publisher.applyPolicy({
        displayName: "retargeted",
        allow: [allowedSetup.publicKey, removedSetup.publicKey],
        services: [
          {
            id: "echo",
            name: "Echo B",
            targetPort: targetBPort,
            allow: [allowedSetup.publicKey, removedSetup.publicKey],
          },
        ],
      }),
      true,
    );
    const updatedRegistryResponse = await fetch(registryUrl, {
      headers: { "if-none-match": initialEtag },
    });
    const updatedEtag = updatedRegistryResponse.headers.get("etag");
    assert.equal(updatedRegistryResponse.status, 200);
    assert.ok(updatedEtag);
    assert.notEqual(updatedEtag, initialEtag);
    const updatedRegistry = (await updatedRegistryResponse.json()) as {
      services: Array<{ id: string; name: string }>;
    };
    assert.deepEqual(
      updatedRegistry.services.map(({ id, name }) => [id, name]),
      [["home", "Home"], ["echo", "Echo B"]],
    );
    assert.equal(await exchangeTcp(allowedEcho.port, "new"), "target-b:new");
    existing.write("after");
    const [after] = await once(existing, "data");
    assert.equal(after.toString(), "target-a:after");

    await publisher.applyPolicy({
      displayName: "retargeted",
      allow: [allowedSetup.publicKey, removedSetup.publicKey],
      services: [
        {
          id: "echo",
          name: "Echo B",
          targetPort: targetBPort,
          allow: [removedSetup.publicKey],
        },
      ],
    });
    const restrictedRegistry = (await fetch(registryUrl).then((response) =>
      response.json())) as { services: Array<{ id: string }> };
    assert.deepEqual(restrictedRegistry.services.map(({ id }) => id), ["home"]);
    assert.equal(await exchangeTcp(allowedEcho.port, "denied"), "");
    assert.equal(await exchangeTcp(removedEcho.port, "allowed"), "target-b:allowed");

    await publisher.applyPolicy({
      displayName: "retargeted",
      allow: [allowedSetup.publicKey],
      services: [
        {
          id: "echo",
          name: "Echo B",
          targetPort: targetBPort,
          allow: [allowedSetup.publicKey],
        },
      ],
    });
    await waitFor(
      () => {
        const keys = publisher?.status().activeSubscriberKeys;
        return keys?.length === 1 && keys[0] === allowedSetup.publicKey;
      },
      "global ACL removal did not leave the expected subscriber active",
    );
    assert.deepEqual(publisher.status().activeSubscriberKeys, [allowedSetup.publicKey]);
    await waitFor(
      () => removed?.status().connection === "reconnecting",
      "removed subscriber did not get a reconnect opportunity",
    );
    assert.equal(await exchangeTcp(removedEcho.port, "reconnect"), "");
    assert.equal(await exchangeTcp(allowedEcho.port, "unaffected"), "target-b:unaffected");
    assert.equal((await fetch(`${allowed.home.url}/healthz`)).status, 200);
    assert.equal((await fetch(`${publisher.home.url}/healthz`)).status, 200);
  } finally {
    existing?.destroy();
    await Promise.allSettled([
      allowed?.stop(),
      removed?.stop(),
      publisher?.stop(),
      closeServer(targetA),
      closeServer(targetB),
      testnet?.destroy(),
      rm(root, { recursive: true, force: true }),
    ]);
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

test("publisher closes non-selected candidates when one reserves the invitation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kepos-pairing-reserve-"));
  const publisherState = path.join(root, "publisher");
  const selectedState = path.join(root, "selected");
  const idleState = path.join(root, "idle");
  let testnet: HyperDhtTestnet | undefined;
  let publisher: RunningPublisher | undefined;
  let selectedDht: DhtNode | undefined;
  let idleDht: DhtNode | undefined;
  let selectedMux: RunningMuxSubscriber | undefined;
  let testError: unknown;

  try {
    const [, , publisherSetup] = await Promise.all([
      setupSubscriber({ stateDir: selectedState }),
      setupSubscriber({ stateDir: idleState }),
      setupPublisher({
        stateDir: publisherState,
        displayName: "kosmos",
        subscriberPublicKeys: [],
        services: [],
      }),
    ]);
    await Promise.all([
      setSubscriberPendingPublisher({
        stateDir: selectedState,
        label: "kosmos",
        publisherKey: publisherSetup.publisherKey,
      }),
      setSubscriberPendingPublisher({
        stateDir: idleState,
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
    const invitation = parsePairingInvitation(
      publisher.createPairingInvitation().uri,
    );
    const [selected, idle] = await Promise.all([
      loadSubscriberConnectionState(selectedState),
      loadSubscriberConnectionState(idleState),
    ]);
    const selectedKeyPair = keyPairFromSecretKey(selected.identity.secretKey);
    const idleKeyPair = keyPairFromSecretKey(idle.identity.secretKey);
    selectedDht = createDht({ bootstrap: testnet.bootstrap, keyPair: selectedKeyPair });
    idleDht = createDht({ bootstrap: testnet.bootstrap, keyPair: idleKeyPair });
    const selectedOuter = selectedDht.connect(
      Buffer.from(publisherSetup.publisherKey, "hex"),
      { keyPair: selectedKeyPair, localConnection: true, reusableSocket: true },
    );
    const idleOuter = idleDht.connect(
      Buffer.from(publisherSetup.publisherKey, "hex"),
      { keyPair: idleKeyPair, localConnection: true, reusableSocket: true },
    );
    selectedOuter.on("error", () => undefined);
    idleOuter.on("error", () => undefined);
    if (!selectedOuter.connected) await once(selectedOuter, "connect");
    if (!idleOuter.connected) await once(idleOuter, "connect");
    await waitFor(
      () => publisher?.acceptedConnections() === 2,
      "publisher did not admit both candidates",
    );
    const idleClosed = new Promise<void>((resolve) => {
      idleOuter.once("close", resolve);
    });
    selectedMux = createMuxSubscriber(selectedOuter, {
      authorized: false,
      heartbeat: false,
    });
    void selectedMux.pair({
      token: invitation.token,
      label: "Selected phone",
      platform: "test",
    }).catch(() => undefined);

    await waitFor(
      () => publisher?.pairingStatus().phase === "pending",
      "selected request did not reserve the invitation",
    );
    await idleClosed;
    assert.equal(idleOuter.destroyed, true);
    assert.equal(selectedOuter.destroyed, false);
    publisher.denyPairing();
  } catch (error) {
    testError = error;
  }

  selectedMux?.close();
  const cleanup = await Promise.allSettled([
    publisher?.stop(),
    selectedDht?.destroy({ force: true }),
    idleDht?.destroy({ force: true }),
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
      `pairing reservation test or cleanup failed: ${errors.map(String).join("; ")}`,
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
