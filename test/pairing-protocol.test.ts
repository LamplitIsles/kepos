import assert from "node:assert/strict";
import { test } from "node:test";

import compactModule from "compact-encoding";

import {
  pairingRequestEncoding,
  pairingResponseEncoding,
} from "../src/pairing/protocol.js";

interface Encoding<T> {
  decode(state: unknown): T;
  encode(state: unknown, value: T): void;
  preencode(state: unknown, value: T): void;
}

interface CompactEncoding {
  decode<T>(encoding: Encoding<T>, buffer: Uint8Array): T;
  encode<T>(encoding: Encoding<T>, value: T): Uint8Array;
}

const c = compactModule as CompactEncoding;

test("pairing request codec round-trips bounded device hints", () => {
  const request = {
    token: Buffer.alloc(32, 7).toString("base64url"),
    label: "Neil's Pixel",
    platform: "android",
  } as const;

  assert.deepEqual(
    c.decode(pairingRequestEncoding, c.encode(pairingRequestEncoding, request)),
    request,
  );
});

test("pairing response codec supports the complete approval lifecycle", () => {
  const responses = [
    { status: "pending" },
    { status: "approved" },
    { status: "denied" },
    { status: "error", code: "invitation-unavailable" },
  ] as const;

  for (const response of responses) {
    assert.deepEqual(
      c.decode(
        pairingResponseEncoding,
        c.encode(pairingResponseEncoding, response),
      ),
      response,
    );
  }
});

test("pairing codecs reject invalid shapes and oversized messages", () => {
  assert.throws(
    () =>
      c.encode(pairingRequestEncoding, {
        token: Buffer.alloc(32).toString("base64url"),
        label: "x".repeat(129),
        platform: "android",
      }),
    /pairing request/i,
  );
  assert.throws(
    () =>
      c.encode(pairingResponseEncoding, {
        status: "error",
        code: "secret-detail" as never,
      }),
    /pairing response/i,
  );

  const oversizedFrame = Buffer.concat([
    Buffer.from([0xfd, 0x01, 0x10]),
    Buffer.alloc(4_097),
  ]);
  assert.throws(
    () => c.decode(pairingRequestEncoding, oversizedFrame),
    /pairing message is too large/i,
  );

  const invalidUtf8 = c.encode(pairingRequestEncoding, {
    token: Buffer.alloc(32).toString("base64url"),
    label: "phone",
    platform: "android",
  });
  invalidUtf8[invalidUtf8.length - 2] = 0xff;
  assert.throws(
    () => c.decode(pairingRequestEncoding, invalidUtf8),
    /payload is invalid/i,
  );
});
