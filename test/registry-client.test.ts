import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { Duplex } from "node:stream";
import { test } from "node:test";

import { createHomeRegistry, type HomeRegistry } from "../src/home/registry.js";
import {
  readHomeRegistry,
  readHomeRegistryFromConnection,
} from "../src/runtime/registry-client.js";

const publisherKey = "ab".repeat(32);

test("Home registry reader accepts content-length, chunked, and close-delimited responses", async () => {
  const registry = createHomeRegistry({
    publisherKey,
    displayName: "reader",
    services: [{ id: "ssh", name: "SSH", kind: "tcp" }],
  });
  const body = Buffer.from(JSON.stringify(registry));

  const contentLength = await readCarrier(
    Buffer.concat([
      Buffer.from(`HTTP/1.1 200 OK\r\nContent-Length: ${body.byteLength}\r\n\r\n`, "latin1"),
      body,
    ]),
  );
  assert.deepEqual(contentLength, registry);

  const chunked = Buffer.from(
    `HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nX-Carrier: test\r\n\r\n` +
      `${body.byteLength.toString(16)};fixture=yes\r\n${body.toString("utf8")}\r\n` +
      "0\r\nX-Trailer: value\r\n\r\n",
    "latin1",
  );
  assert.deepEqual(await readCarrier(chunked), registry);

  const closeDelimited = await readCarrier(
    Buffer.concat([
      Buffer.from("HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n", "latin1"),
      body,
    ]),
    "close",
  );
  assert.deepEqual(closeDelimited, registry);
});

test("Home registry reader rejects malformed response framing and registry bodies", async () => {
  const registry = createHomeRegistry({ publisherKey, displayName: "reader", services: [] });
  const body = Buffer.from(JSON.stringify(registry));
  const response = (headers: string, payload = body): Buffer =>
    Buffer.concat([
      Buffer.from(`HTTP/1.1 200 OK\r\n${headers}\r\n\r\n`, "latin1"),
      payload,
    ]);

  await assert.rejects(
    readCarrier(Buffer.from("HTTP/1.1 200 OK\r\n", "latin1")),
    /headers are invalid/i,
  );
  await assert.rejects(
    readCarrier(Buffer.from("HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n", "latin1")),
    /returned HTTP 204/i,
  );
  await assert.rejects(
    readCarrier(Buffer.from("HTTP/1.1 200 OK\r\nBroken\r\n\r\n", "latin1")),
    /invalid header/i,
  );
  await assert.rejects(
    readCarrier(Buffer.from("HTTP/1.1 200 OK\r\nX-Test: one\r\nx-test: two\r\n\r\n", "latin1")),
    /repeats x-test/i,
  );
  await assert.rejects(readCarrier(response("Content-Length: nope")), /content length is invalid/i);
  await assert.rejects(
    readCarrier(response("Content-Length: 99999999999999999999")),
    /exceeds 64 KiB/i,
  );
  await assert.rejects(
    readCarrier(response(`Content-Length: ${body.byteLength + 1}`)),
    /body is incomplete/i,
  );
  await assert.rejects(
    readCarrier(response("Content-Length: 8", Buffer.from("not-json"))),
    /unexpected token|JSON/i,
  );
  await assert.rejects(
    readCarrier(response("Content-Length: 2", Buffer.from("{}"))),
    /unsupported schema/i,
  );
  const incomplete = Buffer.from('{"schemaVersion":2,"revision":1,"services":[]}');
  await assert.rejects(
    readCarrier(response(`Content-Length: ${incomplete.byteLength}`, incomplete)),
    /incomplete/i,
  );
  const noHome = Buffer.from('{"schemaVersion":2,"revision":1,"publisher":{},"services":[]}');
  await assert.rejects(
    readCarrier(response(`Content-Length: ${noHome.byteLength}`, noHome)),
    /canonical Home service/i,
  );

  await assert.rejects(
    readCarrier(Buffer.from("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nZ\r\n", "latin1")),
    /chunk size is invalid/i,
  );
  await assert.rejects(
    readCarrier(Buffer.from("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nabc", "latin1")),
    /chunk is incomplete/i,
  );
  await assert.rejects(
    readCarrier(Buffer.from("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabcd", "latin1")),
    /chunk is not CRLF terminated|chunk is incomplete/i,
  );
  await assert.rejects(
    readCarrier(Buffer.from("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n0\r\nTrailer", "latin1")),
    /trailers are incomplete/i,
  );
  await assert.rejects(
    readCarrier(
      Buffer.concat([
        Buffer.from("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n", "latin1"),
        Buffer.from("extra", "latin1"),
      ]),
    ),
    /bytes after its response/i,
  );
  await assert.rejects(
    readCarrier(
      Buffer.concat([
        Buffer.from("HTTP/1.1 200 OK\r\n\r\n", "latin1"),
        Buffer.alloc(65 * 1024),
      ]),
    ),
    /exceeds 64 KiB/i,
  );
});

test("Home registry reader settles transport errors, closes, timeouts, and write failures", async () => {
  const errorConnection = new Duplex({
    read() {},
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const errorResult = readHomeRegistryFromConnection(errorConnection, 100);
  setImmediate(() => errorConnection.emit("error", new Error("carrier failed")));
  await assert.rejects(errorResult, /carrier failed/);

  const emptyClose = new Duplex({
    read() {},
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const emptyCloseResult = readHomeRegistryFromConnection(emptyClose, 100);
  setImmediate(() => emptyClose.emit("close"));
  await assert.rejects(emptyCloseResult, /headers are invalid/i);

  const timeout = new Duplex({
    read() {},
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  timeout.on("error", () => undefined);
  await assert.rejects(readHomeRegistryFromConnection(timeout, 1), /timed out after 1ms/i);

  const writeFailure = new Duplex({
    read() {},
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  Object.defineProperty(writeFailure, "write", {
    value: () => {
      throw new Error("write failed");
    },
  });
  await assert.rejects(readHomeRegistryFromConnection(writeFailure), /write failed/i);
});

test("Home registry HTTP reader handles status, valid, oversized, and timeout responses", async () => {
  const registry = createHomeRegistry({ publisherKey, displayName: "http", services: [] });
  let mode: "valid" | "status" | "oversized" | "timeout" = "valid";
  const server = createServer((_request, response) => {
    if (mode === "status") {
      response.writeHead(503);
      response.end("not ready");
    } else if (mode === "oversized") {
      response.end(Buffer.alloc(65 * 1024, "x"));
    } else if (mode === "timeout") {
      // The client owns the timeout and will close this request.
    } else {
      response.end(JSON.stringify(registry));
    }
  });
  await listen(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("registry test server has no address");
  try {
    assert.deepEqual(await readHomeRegistry(address.port), registry);
    mode = "status";
    await assert.rejects(readHomeRegistry(address.port), /returned HTTP 503/i);
    mode = "oversized";
    await assert.rejects(readHomeRegistry(address.port), /exceeds 64 KiB/i);
    mode = "timeout";
    await assert.rejects(readHomeRegistry(address.port, 1), /timed out after 1ms|socket hang up/i);
  } finally {
    await closeServer(server);
  }
});

function readCarrier(source: Buffer, ending: "end" | "close" = "end"): Promise<HomeRegistry> {
  const connection = new Duplex({
    read() {},
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const result = readHomeRegistryFromConnection(connection);
  setImmediate(() => {
    connection.emit("data", source);
    connection.emit(ending);
  });
  return result;
}

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}
