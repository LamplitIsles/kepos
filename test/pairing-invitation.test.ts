import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createPairingInvitation,
  parsePairingInvitation,
  pairingTokenMatches,
} from "../src/pairing/invitation.js";

test("pairing invitation round-trips publisher metadata without retaining the raw token", () => {
  const now = 1_750_000_000_456;
  const expiresAt = Math.floor((now + 120_000) / 1_000) * 1_000;
  const issued = createPairingInvitation({
    publisherKey: "ab".repeat(32),
    displayName: "Neil's Mac",
    now: () => now,
    randomBytes: () => Buffer.alloc(32, 7),
  });

  assert.equal("token" in issued, false);
  assert.equal(issued.expiresAt, expiresAt);
  assert.equal(issued.tokenDigest.length, 32);

  const parsed = parsePairingInvitation(issued.uri, { now: () => now });
  assert.deepEqual(
    {
      publisherKey: parsed.publisherKey,
      displayName: parsed.displayName,
      expiresAt: parsed.expiresAt,
    },
    {
      publisherKey: "ab".repeat(32),
      displayName: "Neil's Mac",
      expiresAt,
    },
  );
  assert.equal(pairingTokenMatches(parsed.token, issued.tokenDigest), true);
  assert.equal(
    pairingTokenMatches(Buffer.alloc(32, 8).toString("base64url"), issued.tokenDigest),
    false,
  );
});

test("pairing invitation parsing works with Bare URLSearchParams", () => {
  const now = 1_750_000_000_000;
  const invitation = createPairingInvitation({
    publisherKey: "ab".repeat(32),
    displayName: "Kosmos",
    now: () => now,
    randomBytes: () => Buffer.alloc(32, 7),
  });
  const descriptor = Object.getOwnPropertyDescriptor(
    URLSearchParams.prototype,
    "keys",
  );
  Object.defineProperty(URLSearchParams.prototype, "keys", {
    configurable: true,
    value: undefined,
  });
  try {
    assert.equal(
      parsePairingInvitation(invitation.uri, { now: () => now }).publisherKey,
      "ab".repeat(32),
    );
  } finally {
    if (descriptor) {
      Object.defineProperty(URLSearchParams.prototype, "keys", descriptor);
    } else {
      delete (URLSearchParams.prototype as { keys?: unknown }).keys;
    }
  }
});

test("pairing invitation creation requires exactly 32 random bytes", () => {
  assert.throws(
    () =>
      createPairingInvitation({
        publisherKey: "ab".repeat(32),
        displayName: "Kosmos",
        randomBytes: () => Buffer.alloc(31),
      }),
    /pairing token/i,
  );
});

test("pairing invitation parser rejects ambiguous and non-canonical payloads", () => {
  const now = 1_750_000_000_000;
  const issued = createPairingInvitation({
    publisherKey: "cd".repeat(32),
    displayName: "Kosmos",
    now: () => now,
    randomBytes: () => Buffer.alloc(32, 9),
  });
  const mutations = [
    "not a URI",
    `${issued.uri}&extra=value`,
    `${issued.uri}&token=${Buffer.alloc(32, 3).toString("base64url")}`,
    issued.uri.replace("kepos://pair?", "kepos://user@pair?"),
    issued.uri.replace("kepos://pair?", "kepos://pair/path?"),
    `${issued.uri}#fragment`,
    issued.uri.replace(/expires=\d+/u, "expires=1e12"),
    issued.uri.replace(/expires=\d+/u, "expires=01750000120"),
  ];

  for (const source of mutations) {
    assert.throws(
      () => parsePairingInvitation(source, { now: () => now }),
      /pairing invitation/i,
      source,
    );
  }
});
