import assert from "node:assert/strict";
import { once } from "node:events";
import { request } from "node:http";
import { createConnection, type Socket } from "node:net";
import { PassThrough } from "node:stream";
import { test } from "node:test";

import {
  DEFAULT_GATEWAY_PORT,
  startHttpGateway,
} from "../src/home/gateway.js";

const maximumHeaderBytes = 16 * 1024;

test("HTTP gateway has a fixed default port", () => {
  assert.equal(DEFAULT_GATEWAY_PORT, 17_480);
});

test("HTTP gateway binds to loopback unless a host is explicit", async () => {
  const loopback = await startHttpGateway({
    port: 0,
    open: async () => new Promise<never>(() => undefined),
  });
  const exposed = await startHttpGateway({
    port: 0,
    host: "0.0.0.0",
    open: async () => new Promise<never>(() => undefined),
  });

  try {
    assert.deepEqual(loopback.server.address(), {
      address: "127.0.0.1",
      family: "IPv4",
      port: loopback.port,
    });
    assert.deepEqual(exposed.server.address(), {
      address: "0.0.0.0",
      family: "IPv4",
      port: exposed.port,
    });
  } finally {
    await Promise.all([closeGateway(loopback), closeGateway(exposed)]);
  }
});

test("HTTP gateway adds one configured domain without losing localhost", async () => {
  const gateway = await startHttpGateway({
    port: 0,
    domain: "kepos.internal",
    acquisitionTimeoutMs: 5,
    open: async () => new Promise<never>(() => undefined),
  });

  try {
    const [podStatus, nodeStatus, unrelatedStatus] = await Promise.all([
      requestStatus(gateway.port, "navidrome.kepos.internal"),
      requestStatus(gateway.port, "navidrome.localhost"),
      requestStatus(gateway.port, "navidrome.example.com"),
    ]);
    assert.equal(podStatus, 503);
    assert.equal(nodeStatus, 503);
    assert.equal(unrelatedStatus, 421);
  } finally {
    await closeGateway(gateway);
  }
});

test("HTTP gateway does not accept a private domain by default", async () => {
  const gateway = await startHttpGateway({
    port: 0,
    open: async () => new Promise<never>(() => undefined),
  });

  try {
    assert.equal(
      await requestStatus(gateway.port, "navidrome.kepos.internal"),
      421,
    );
  } finally {
    await closeGateway(gateway);
  }
});

test("HTTP gateway reports unavailable when tunnel acquisition times out", async () => {
  const gateway = await startHttpGateway({
    port: 0,
    acquisitionTimeoutMs: 5,
    open: async () => new Promise<never>(() => undefined),
  });

  try {
    const response = await fetch(
      `http://navidrome.localhost:${gateway.port}/rest/ping`,
    );
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("retry-after"), "1");
  } finally {
    await closeGateway(gateway);
  }
});

test("HTTP gateway routes a coalesced body that previously triggered 431", async () => {
  const body = Buffer.alloc(20_000);
  for (let index = 0; index < body.length; index++) {
    body[index] = index % 251;
  }
  const requestBytes = makeRequest(body);
  await assertEchoedRequest(requestBytes, [requestBytes]);
});

test("HTTP gateway forwards body bytes when the header terminator is split", async () => {
  const body = Buffer.from("body attached to the final chunk\0\xff", "latin1");
  const header = Buffer.from(
    `POST /upload HTTP/1.1\r\nHost: navidrome.localhost\r\nContent-Length: ${body.length}\r\n\r\n`,
    "latin1",
  );
  const requestBytes = Buffer.concat([header, body]);
  const firstChunk = header.subarray(0, header.length - 2);
  const finalChunk = Buffer.concat([header.subarray(header.length - 2), body]);
  await assertEchoedRequest(requestBytes, [firstChunk, finalChunk]);
});

test("HTTP gateway accepts a complete header exactly at the 16 KiB limit", async () => {
  const header = makeHeader(maximumHeaderBytes);
  const body = Buffer.from("body is not part of the header bound", "latin1");
  const requestBytes = Buffer.concat([header, body]);
  await assertEchoedRequest(requestBytes, [requestBytes]);
});

test("HTTP gateway rejects a terminated header above the 16 KiB limit", async () => {
  await assertRejectedHeader(makeHeader(maximumHeaderBytes + 1));
});

test("HTTP gateway rejects an unterminated header above the 16 KiB limit", async () => {
  await assertRejectedHeader(makeUnterminatedHeader(maximumHeaderBytes + 1));
});

test("HTTP gateway waits at the exact limit before rejecting an oversized header", async () => {
  await assertRejectedHeader([
    makeUnterminatedHeader(maximumHeaderBytes),
    Buffer.from("\r\n\r\n", "latin1"),
  ]);
});

async function closeGateway(
  gateway: Awaited<ReturnType<typeof startHttpGateway>>,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    gateway.server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function requestStatus(port: number, host: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const outgoing = request({
      hostname: "127.0.0.1",
      port,
      headers: { host },
    });
    outgoing.once("response", (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    outgoing.once("error", reject);
    outgoing.end();
  });
}

async function assertEchoedRequest(
  requestBytes: Buffer,
  chunks: readonly Buffer[],
): Promise<void> {
  const acquired: string[] = [];
  const gateway = await startHttpGateway({
    port: 0,
    open: async (serviceId) => {
      acquired.push(serviceId);
      return new PassThrough();
    },
  });
  const client = await connectToGateway(gateway.port);

  try {
    const echoed = readSocket(client, requestBytes.length);
    for (const [index, chunk] of chunks.entries()) {
      client.write(chunk);
      if (index < chunks.length - 1) await nextTurn();
    }
    assert.deepEqual(await echoed, requestBytes);
    assert.deepEqual(acquired, ["navidrome"]);
  } finally {
    client.destroy();
    await closeGateway(gateway);
  }
}

async function assertRejectedHeader(chunks: Buffer | readonly Buffer[]): Promise<void> {
  const acquired: string[] = [];
  const gateway = await startHttpGateway({
    port: 0,
    open: async (serviceId) => {
      acquired.push(serviceId);
      throw new Error("oversized request must not acquire a service");
    },
  });
  const client = await connectToGateway(gateway.port);

  try {
    const response = readSocket(client);
    let responseStarted = false;
    client.once("data", () => {
      responseStarted = true;
    });
    client.once("end", () => {
      responseStarted = true;
    });
    const parts = Buffer.isBuffer(chunks) ? [chunks] : chunks;
    for (const [index, chunk] of parts.entries()) {
      if (index === parts.length - 1) {
        if (parts.length > 1) assert.equal(responseStarted, false);
        client.end(chunk);
      } else await writeChunk(client, chunk);
    }
    assert.match(
      (await response).toString("latin1"),
      /^HTTP\/1\.1 431 Request Header Fields Too Large\r\n/,
    );
    assert.deepEqual(acquired, []);
  } finally {
    client.destroy();
    await closeGateway(gateway);
  }
}

async function connectToGateway(port: number): Promise<Socket> {
  const socket = createConnection({ host: "127.0.0.1", port });
  socket.setNoDelay(true);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  return socket;
}

function readSocket(socket: Socket, minimumLength?: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    const cleanup = (): void => {
      socket.off("data", onData);
      socket.off("end", onEnd);
      socket.off("error", onError);
    };
    const finish = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    const onData = (chunk: Buffer): void => {
      chunks.push(Buffer.from(chunk));
      size += chunk.length;
      if (minimumLength !== undefined && size >= minimumLength) finish();
    };
    const onEnd = (): void => finish();
    const onError = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    socket.on("data", onData);
    socket.on("end", onEnd);
    socket.on("error", onError);
  });
}

function makeRequest(body: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(
      `POST /upload HTTP/1.1\r\nHost: navidrome.localhost\r\nContent-Length: ${body.length}\r\n\r\n`,
      "latin1",
    ),
    body,
  ]);
}

function makeHeader(length: number): Buffer {
  const prefix = Buffer.from(
    "GET / HTTP/1.1\r\nHost: navidrome.localhost\r\nX-Pad: ",
    "latin1",
  );
  const suffix = Buffer.from("\r\n\r\n", "latin1");
  assert.ok(length >= prefix.length + suffix.length);
  return Buffer.concat([
    prefix,
    Buffer.alloc(length - prefix.length - suffix.length, 0x61),
    suffix,
  ]);
}

function makeUnterminatedHeader(length: number): Buffer {
  const prefix = Buffer.from(
    "GET / HTTP/1.1\r\nHost: navidrome.localhost\r\nX-Pad: ",
    "latin1",
  );
  assert.ok(length >= prefix.length);
  return Buffer.concat([prefix, Buffer.alloc(length - prefix.length, 0x61)]);
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function writeChunk(socket: Socket, chunk: Buffer): Promise<void> {
  if (!socket.write(chunk)) await once(socket, "drain");
  // Let the loop deliver this chunk before the caller writes the continuation.
  for (let turn = 0; turn < 3; turn++) await nextTurn();
}
