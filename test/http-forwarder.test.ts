import assert from "node:assert/strict";
import { Duplex, PassThrough } from "node:stream";
import { test } from "node:test";

import {
  bridgeHttp1,
  createHttpRequestForwarder,
  maximumHttpRequestHeadBytes,
  rewriteHttpRequestHead,
} from "../src/mux/http-forwarder.js";

const subscriberPublicKey = "0123456789abcdef".repeat(4);

interface ForwardResult {
  data: Buffer;
  error?: Error;
}

class TestHttpTunnel extends Duplex {
  readonly closeTriggers: string[] = [];
  readonly writes: Buffer[] = [];

  override _read(): void {}

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.writes.push(Buffer.from(chunk));
    callback();
  }

  closeFrom(trigger: string, error?: Error): void {
    this.closeTriggers.push(trigger);
    this.destroy(error);
  }
}

class TestTarget extends Duplex {
  readonly requests: Buffer[] = [];

  override _read(): void {}

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.requests.push(Buffer.from(chunk));
    callback();
  }
}

function closes(stream: Duplex): Promise<void> {
  return new Promise<void>((resolve) => stream.once("close", resolve));
}

async function forward(
  chunks: readonly Uint8Array[],
): Promise<ForwardResult> {
  const forwarder = createHttpRequestForwarder(subscriberPublicKey);
  const output: Buffer[] = [];
  forwarder.on("data", (chunk: Buffer) => output.push(Buffer.from(chunk)));

  const result = new Promise<ForwardResult>((resolve) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      resolve({ data: Buffer.concat(output), ...(error ? { error } : {}) });
    };
    forwarder.once("end", () => finish());
    forwarder.once("error", (error: Error) => finish(error));
  });

  for (const chunk of chunks) forwarder.write(chunk);
  forwarder.end();
  return result;
}

function bytes(source: string): Buffer {
  return Buffer.from(source, "latin1");
}

function splitEvery(input: Uint8Array, size: number): Buffer[] {
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < input.byteLength; offset += size) {
    chunks.push(Buffer.from(input.subarray(offset, offset + size)));
  }
  return chunks;
}

function request(
  requestLine: string,
  headers: readonly string[],
  body = "",
): Buffer {
  return bytes(
    `${requestLine}\r\n${headers.join("\r\n")}\r\n\r\n${body}`,
  );
}

async function waitFor(
  predicate: () => boolean,
  message: string,
): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

test("rewrites a split Content-Length request and preserves its body", async () => {
  const body = bytes("body");
  const input = request(
    "POST /upload HTTP/1.1",
    [
      "Host: target.example",
      "aUtHoRiZaTiOn: Bearer caller-controlled",
      `Content-Length: ${body.byteLength}`,
    ],
    body.toString("latin1"),
  );
  const result = await forward(splitEvery(input, 3));

  assert.equal(result.error, undefined);
  const expectedHead = rewriteHttpRequestHead(
    bytes(
      `POST /upload HTTP/1.1\r\nHost: target.example\r\nContent-Length: ${body.byteLength}\r\n\r\n`,
    ),
    subscriberPublicKey,
  );
  assert.deepEqual(result.data, Buffer.concat([expectedHead, body]));
  assert.equal(
    result.data.toString("latin1").match(/authorization:/gi)?.length,
    1,
  );
  assert.match(
    result.data.toString("latin1"),
    new RegExp(`Authorization: Kepos ${subscriberPublicKey}`),
  );
});

test("rewrites sequential coalesced requests without parsing body bytes as heads", async () => {
  const body = bytes(
    "GET /body-looks-like-a-request HTTP/1.1\r\nHost: body.example\r\n\r\n",
  );
  const first = request(
    "POST /first HTTP/1.1",
    [
      "Host: target.example",
      `Content-Length: ${body.byteLength}`,
      "Authorization: Basic forged",
    ],
    body.toString("latin1"),
  );
  const second = request("GET /second HTTP/1.1", [
    "Host: target.example",
    "AUTHORIZATION: Bearer forged-again",
  ]);
  const result = await forward([Buffer.concat([first, second])]);

  assert.equal(result.error, undefined);
  const firstHead = rewriteHttpRequestHead(
    first.subarray(0, first.indexOf(bytes("\r\n\r\n")) + 4),
    subscriberPublicKey,
  );
  const secondHead = rewriteHttpRequestHead(second, subscriberPublicKey);
  assert.deepEqual(
    result.data,
    Buffer.concat([firstHead, body, secondHead]),
  );
  assert.equal(
    result.data.toString("latin1").match(/Authorization:/g)?.length,
    2,
  );
  assert.equal(result.data.toString("latin1").includes("forged"), false);
});

test("forwards split chunked bodies and then rewrites the next request", async () => {
  const firstHead = bytes(
    "POST /chunked HTTP/1.1\r\nHost: target.example\r\nTransfer-Encoding: chunked\r\nAuthorization: forged\r\n\r\n",
  );
  const chunkedBody = bytes(
    "4;trace=yes\r\nWiki\r\n5\r\npedia\r\n0\r\nX-Request-Trace: kept\r\nAuthorization: dropped\r\n\r\n",
  );
  const second = request("GET /after-chunked HTTP/1.1", [
    "Host: target.example",
    "Authorization: forged-second",
  ]);
  const input = Buffer.concat([firstHead, chunkedBody, second]);
  const result = await forward(splitEvery(input, 1));

  assert.equal(result.error, undefined);
  const rewrittenFirst = rewriteHttpRequestHead(
    firstHead,
    subscriberPublicKey,
  );
  const rewrittenSecond = rewriteHttpRequestHead(second, subscriberPublicKey);
  const expectedChunkedBody = bytes(
    "4;trace=yes\r\nWiki\r\n5\r\npedia\r\n0\r\nX-Request-Trace: kept\r\n\r\n",
  );
  assert.deepEqual(
    result.data,
    Buffer.concat([rewrittenFirst, expectedChunkedBody, rewrittenSecond]),
  );
  assert.equal(
    result.data.toString("latin1").match(/Authorization:/g)?.length,
    2,
  );
  assert.equal(result.data.toString("latin1").includes("dropped"), false);
});

test("rejects malformed, ambiguous, and oversized request heads", async () => {
  const cases = [
    [
      "bare LF",
      bytes("GET / HTTP/1.1\nHost: target.example\n\n"),
      /CRLF|complete request head/,
    ],
    [
      "missing Host",
      bytes("GET / HTTP/1.1\r\nConnection: close\r\n\r\n"),
      /exactly one Host/,
    ],
    [
      "non-ASCII request target",
      bytes("GET /\x81 HTTP/1.1\r\nHost: target.example\r\n\r\n"),
      /target is malformed/,
    ],
    [
      "non-ASCII Host",
      bytes("GET / HTTP/1.1\r\nHost: target.\x81example\r\n\r\n"),
      /invalid Host/,
    ],
    [
      "duplicate Content-Length",
      bytes(
        "POST / HTTP/1.1\r\nHost: target.example\r\nContent-Length: 1\r\ncontent-length: 1\r\n\r\n",
      ),
      /ambiguous Content-Length/,
    ],
    [
      "Content-Length and Transfer-Encoding",
      bytes(
        "POST / HTTP/1.1\r\nHost: target.example\r\nContent-Length: 1\r\nTransfer-Encoding: chunked\r\n\r\n",
      ),
      /conflicting/,
    ],
    [
      "unsupported Transfer-Encoding",
      bytes(
        "POST / HTTP/1.1\r\nHost: target.example\r\nTransfer-Encoding: gzip\r\n\r\n",
      ),
      /unsupported/,
    ],
    [
      "oversized",
      bytes(
        `GET / HTTP/1.1\r\nHost: target.example\r\nX-Fill: ${"x".repeat(maximumHttpRequestHeadBytes)}\r\n\r\n`,
      ),
      /exceeds/,
    ],
  ] as const;

  for (const [name, input, message] of cases) {
    const result = await forward([input]);
    assert.ok(result.error, name);
    assert.match(String(result.error), message, name);
    assert.equal(result.data.byteLength, 0, name);
  }
});

test("rejects malformed chunk syntax without forwarding the malformed bytes", async () => {
  const head = bytes(
    "POST /chunked HTTP/1.1\r\nHost: target.example\r\nTransfer-Encoding: chunked\r\n\r\n",
  );
  const malformedSizes = await forward([Buffer.concat([head, bytes("Z\r\n")])]);
  assert.ok(malformedSizes.error);
  assert.equal(malformedSizes.data.toString("latin1").includes("Z\r\n"), false);

  const malformedCrlf = await forward([
    Buffer.concat([head, bytes("1\r\nAxx")]),
  ]);
  assert.ok(malformedCrlf.error);
  assert.equal(malformedCrlf.data.toString("latin1").endsWith("1\r\nA"), true);
  assert.equal(malformedCrlf.data.toString("latin1").includes("xx"), false);

  const malformedTrailer = await forward([
    Buffer.concat([head, bytes("0\r\nBad-Trailer\r\n\r\n")]),
  ]);
  assert.ok(malformedTrailer.error);
  assert.equal(
    malformedTrailer.data.toString("latin1").includes("Bad-Trailer"),
    false,
  );
});

test("rejects incomplete bodies and a malformed second request before forwarding it", async () => {
  const incomplete = await forward([
    request(
      "POST /incomplete HTTP/1.1",
      ["Host: target.example", "Content-Length: 5"],
      "abc",
    ),
  ]);
  assert.ok(incomplete.error);
  assert.match(String(incomplete.error), /declared body/);

  const first = request("GET /ok HTTP/1.1", ["Host: target.example"]);
  const malformedSecond = bytes(
    "POST /bad HTTP/1.1\r\nHost: target.example\r\nContent-Length: 1\r\nContent-Length: 1\r\nAuthorization: forged\r\n\r\nX",
  );
  const result = await forward([Buffer.concat([first, malformedSecond])]);
  assert.ok(result.error);
  assert.match(String(result.error), /ambiguous Content-Length/);
  const output = result.data.toString("latin1");
  assert.equal(output.includes("/bad"), false);
  assert.equal(output.includes("forged"), false);
  assert.equal(output.match(/Authorization:/g)?.length, 1);

  const bodylessOverflow = await forward([
    Buffer.concat([first, bytes("not a second request")]),
  ]);
  assert.ok(bodylessOverflow.error);
  assert.equal(
    bodylessOverflow.data.toString("latin1").includes("not a second request"),
    false,
  );
});

test("holds WebSocket post-handshake bytes until a split 101 response", async () => {
  const tunnel = new TestHttpTunnel();
  const target = new TestTarget();
  tunnel.on("error", () => undefined);
  target.on("error", () => undefined);
  bridgeHttp1(tunnel, target, subscriberPublicKey);

  const handshake = bytes(
    "GET /socket HTTP/1.1\r\nHost: target.example\r\nUpgrade: WebSocket\r\nConnection: keep-alive, Upgrade\r\nAuthorization: Bearer forged\r\nSec-WebSocket-Version: 13\r\n\r\n",
  );
  const opaque = Buffer.from([0, 255, 1, 2, 128, 42]);
  tunnel.push(Buffer.concat([handshake, opaque]));
  await waitFor(() => target.requests.length === 1, "WebSocket head was not forwarded");
  assert.equal(Buffer.concat(target.requests).includes(opaque), false);
  const targetHead = target.requests[0].toString("latin1");
  assert.equal(targetHead.match(/authorization:/gi)?.length, 1);
  assert.match(
    targetHead,
    new RegExp(`Authorization: Kepos ${subscriberPublicKey}`),
  );
  assert.equal(targetHead.includes("forged"), false);

  const response = bytes(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
  );
  const targetOpaque = Buffer.alloc(maximumHttpRequestHeadBytes + 1, 23);
  target.push(response.subarray(0, 19));
  target.push(Buffer.concat([response.subarray(19), targetOpaque]));
  await waitFor(
    () =>
      Buffer.concat(tunnel.writes).equals(
        Buffer.concat([response, targetOpaque]),
      ),
    "split WebSocket 101 response and coalesced opaque bytes were not forwarded",
  );
  await waitFor(
    () => Buffer.concat(target.requests).subarray(target.requests[0].byteLength).equals(opaque),
    "post-handshake bytes were not released",
  );
  assert.deepEqual(
    Buffer.concat(target.requests).subarray(target.requests[0].byteLength),
    opaque,
  );

  tunnel.destroy();
  target.destroy();
});

test("does not forward a non-fresh WebSocket Upgrade head", async () => {
  const first = request("GET /first HTTP/1.1", ["Host: target.example"]);
  const upgrade = request("GET /socket HTTP/1.1", [
    "Host: target.example",
    "Upgrade: websocket",
    "Connection: Upgrade",
    "Authorization: forged",
  ]);
  const result = await forward([Buffer.concat([first, upgrade])]);
  assert.ok(result.error);
  assert.match(String(result.error), /fresh HTTP service tunnel/);
  assert.equal(result.data.toString("latin1").includes("/first"), true);
  assert.equal(result.data.toString("latin1").includes("/socket"), false);
  assert.equal(result.data.toString("latin1").includes("forged"), false);
});

test("keeps a rejected WebSocket Upgrade on the ordinary HTTP path", async () => {
  const tunnel = new TestHttpTunnel();
  const target = new TestTarget();
  tunnel.on("error", () => undefined);
  target.on("error", () => undefined);
  bridgeHttp1(tunnel, target, subscriberPublicKey);

  const upgrade = bytes(
    "GET /reject HTTP/1.1\r\nHost: target.example\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nAuthorization: forged\r\n\r\n",
  );
  const next = request("GET /ordinary HTTP/1.1", [
    "Host: target.example",
    "Authorization: forged-next",
  ]);
  tunnel.push(Buffer.concat([upgrade, next]));
  await waitFor(() => target.requests.length === 1, "Upgrade head was not forwarded");
  target.push(
    bytes(
      "HTTP/1.1 403 Forbidden\r\nUpgrade: h2c\r\nContent-Length: 0\r\n\r\n",
    ),
  );
  await waitFor(
    () => target.requests.length === 2,
    "ordinary request did not resume after rejected Upgrade",
  );
  const ordinaryHead = target.requests[1].toString("latin1");
  assert.match(
    ordinaryHead,
    new RegExp(`Authorization: Kepos ${subscriberPublicKey}`),
  );
  assert.equal(ordinaryHead.includes("forged-next"), false);

  tunnel.destroy();
  target.destroy();
});

test("rejects non-WebSocket Upgrade variants and malformed Upgrade responses", async () => {
  const variants = [
    "GET / HTTP/1.1\r\nHost: target.example\r\nUpgrade: h2c\r\nConnection: Upgrade\r\n\r\n",
    "GET / HTTP/1.1\r\nHost: target.example\r\nUpgrade: websocket\r\nConnection: keep-alive\r\n\r\n",
    "GET / HTTP/1.1\r\nHost: target.example\r\nConnection: Upgrade\r\n\r\n",
    "POST / HTTP/1.1\r\nHost: target.example\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
    "GET / HTTP/1.1\r\nHost: target.example\r\nUpgrade: websocket\r\nConnection: Upgrade,,keep-alive\r\n\r\n",
  ];
  for (const variant of variants) {
    assert.throws(
      () => rewriteHttpRequestHead(bytes(variant), subscriberPublicKey),
      /unsupported|valid WebSocket|malformed Connection/,
    );
  }

  const tunnel = new TestHttpTunnel();
  const target = new TestTarget();
  tunnel.on("error", () => undefined);
  target.on("error", () => undefined);
  bridgeHttp1(tunnel, target, subscriberPublicKey);
  const closed = closes(tunnel);
  tunnel.push(
    bytes(
      "GET / HTTP/1.1\r\nHost: target.example\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
    ),
  );
  await waitFor(() => target.requests.length === 1, "Upgrade head was not forwarded");
  target.push(Buffer.alloc(maximumHttpRequestHeadBytes + 1, 65));
  await closed;
  assert.deepEqual(tunnel.closeTriggers, ["forwarder.error"]);
  target.destroy();
});

test("HTTP bridge preserves target error and close lifecycle triggers", async () => {
  const erroredTunnel = new TestHttpTunnel();
  const erroredTarget = new PassThrough();
  erroredTunnel.on("error", () => undefined);
  bridgeHttp1(erroredTunnel, erroredTarget, subscriberPublicKey);
  const erroredClosed = closes(erroredTunnel);
  erroredTarget.destroy(new Error("target failed"));
  await erroredClosed;
  assert.deepEqual(erroredTunnel.closeTriggers, ["target.error"]);

  const closedTunnel = new TestHttpTunnel();
  const closedTarget = new PassThrough();
  bridgeHttp1(closedTunnel, closedTarget, subscriberPublicKey);
  const closed = closes(closedTunnel);
  closedTarget.destroy();
  await closed;
  assert.deepEqual(closedTunnel.closeTriggers, ["target.close"]);
});
