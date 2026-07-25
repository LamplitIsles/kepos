import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  encodeFrame,
  FrameDecoder,
  MAX_CONTROL_FRAME_BYTES,
} from "../packages/bare-host-protocol/src/framing.js";
import {
  parseEnvelope,
  PROTOCOL_VERSION,
  type ErrorEnvelope,
  type EventEnvelope,
  type RequestEnvelope,
  type ResponseEnvelope,
} from "../packages/bare-host-protocol/src/messages.js";
import { RequestTracker } from "../packages/bare-host-protocol/src/request-tracker.js";

test("Bare host protocol exports one bounded versioned frame format", async () => {
  const protocol = (await import(
    "../packages/bare-host-protocol/src/framing.js"
  )) as Record<string, unknown>;

  assert.equal(PROTOCOL_VERSION, 1);
  assert.equal(MAX_CONTROL_FRAME_BYTES, 64 * 1024);
  assert.equal(typeof protocol.encodeFrame, "function");
  assert.equal(typeof protocol.FrameDecoder, "function");
  assert.equal(typeof parseEnvelope, "function");
  assert.equal(typeof RequestTracker, "function");
});

test("Bare host request tracker rejects an unknown response id", () => {
  const tracker = new RequestTracker();
  const first = tracker.request("ping");
  const second = tracker.request("status");

  assert.equal(first.id, 1);
  assert.equal(second.id, 2);
  assert.deepEqual(
    tracker.accept({
      version: 1,
      kind: "response",
      id: first.id,
      result: "pong",
    }),
    {
      version: 1,
      kind: "response",
      id: first.id,
      result: "pong",
    },
  );
  assert.throws(
    () =>
      tracker.accept({
        version: 1,
        kind: "response",
        id: 99,
        result: null,
      }),
    /unknown response id/,
  );
});

test("Bare host protocol accepts response, error, and state event envelopes", () => {
  const response: ResponseEnvelope = {
    version: 1,
    kind: "response",
    id: 7,
    result: { runtimeId: "runtime-1" },
  };
  const error: ErrorEnvelope = {
    version: 1,
    kind: "error",
    id: 8,
    error: { code: "stopped", message: "runtime stopped" },
  };
  const event: EventEnvelope = {
    version: 1,
    kind: "event",
    event: "runtime.stateChanged",
    data: { state: "running" },
  };

  assert.deepEqual(parseEnvelope(response), response);
  assert.deepEqual(parseEnvelope(error), error);
  assert.deepEqual(parseEnvelope(event), event);
});

test("Bare host protocol round-trips a request frame", () => {
  const request: RequestEnvelope = {
    version: 1,
    kind: "request",
    id: 7,
    method: "ping",
  };

  const frame = encodeFrame(request);
  const declaredLength = new DataView(
    frame.buffer,
    frame.byteOffset,
    4,
  ).getUint32(0);

  assert.equal(declaredLength, frame.byteLength - 4);
  assert.deepEqual(new FrameDecoder().push(frame), [request]);
});

test("Bare host TypeScript encoding matches the shared wire fixture", async () => {
  const expected = (
    await readFile(
      new URL(
        "../packages/bare-host-protocol/fixtures/request-ping-v1.hex",
        import.meta.url,
      ),
      "utf8",
    )
  ).trim();

  assert.equal(
    Buffer.from(
      encodeFrame({ version: 1, kind: "request", id: 7, method: "ping" }),
    ).toString("hex"),
    expected,
  );
});

test("Bare host decoder accepts fragmented and coalesced frames", () => {
  const first = encodeFrame({
    version: 1,
    kind: "request",
    id: 1,
    method: "ping",
  });
  const second = encodeFrame({
    version: 1,
    kind: "request",
    id: 2,
    method: "status",
  });
  const decoder = new FrameDecoder();

  assert.deepEqual(decoder.push(first.subarray(0, 2)), []);
  assert.deepEqual(decoder.push(first.subarray(2, 9)), []);
  assert.deepEqual(decoder.push(first.subarray(9)), [
    { version: 1, kind: "request", id: 1, method: "ping" },
  ]);

  const coalesced = new Uint8Array(first.byteLength + second.byteLength);
  coalesced.set(first);
  coalesced.set(second, first.byteLength);
  assert.deepEqual(new FrameDecoder().push(coalesced), [
    { version: 1, kind: "request", id: 1, method: "ping" },
    { version: 1, kind: "request", id: 2, method: "status" },
  ]);
});

test("Bare host decoder rejects invalid lengths, UTF-8, JSON, and versions", () => {
  const zeroLength = new Uint8Array(4);
  const oversized = new Uint8Array(4);
  new DataView(oversized.buffer).setUint32(0, 64 * 1024 + 1);

  assert.throws(() => new FrameDecoder().push(zeroLength), /length/);
  assert.throws(() => new FrameDecoder().push(oversized), /length/);
  assert.throws(
    () => new FrameDecoder().push(rawFrame(new Uint8Array([0xff]))),
    /UTF-8 JSON/,
  );
  assert.throws(
    () => new FrameDecoder().push(rawFrame(new TextEncoder().encode("{"))),
    /UTF-8 JSON/,
  );
  assert.throws(
    () =>
      new FrameDecoder().push(
        rawFrame(
          new TextEncoder().encode(
            JSON.stringify({
              version: 2,
              kind: "request",
              id: 1,
              method: "ping",
            }),
          ),
        ),
      ),
    /version/,
  );
});

test("Bare host protocol rejects invalid request ids and methods", () => {
  for (const id of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => parseEnvelope({ version: 1, kind: "request", id, method: "ping" }),
      /positive integer/,
    );
  }
  assert.throws(
    () =>
      parseEnvelope({ version: 1, kind: "request", id: 1, method: "eval" }),
    /method/,
  );
});

test("Bare host protocol carries publisher configuration without exposing eval", () => {
  const request: RequestEnvelope = {
    version: 1,
    kind: "request",
    id: 11,
    method: "configure",
    params: {
      publisherKey: "ab".repeat(32),
    },
  };

  assert.deepEqual(parseEnvelope(request), request);
});

test("Bare host protocol carries a pairing invitation without a private key", () => {
  const request = {
    version: 1,
    kind: "request",
    id: 12,
    method: "pair",
    params: {
      invitation: "kepos://pair?v=1&token=one-time",
      deviceLabel: "Neil's Pixel",
      platform: "android",
    },
  };

  assert.deepEqual(parseEnvelope(request), request);
  assert.doesNotMatch(JSON.stringify(request), /privateKey|secretKey|seed/);
});

function rawFrame(payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(4 + payload.byteLength);
  new DataView(frame.buffer).setUint32(0, payload.byteLength);
  frame.set(payload, 4);
  return frame;
}
