import assert from "node:assert/strict";
import { test } from "node:test";

import {
  derivePublisherHomeKey,
  generateClientIdentity,
  generatePublisherSeed,
  parseClientIdentity,
  serializeClientIdentity,
} from "../src/keys.js";
import { keyPairFromSecretKey } from "../src/mux/hyperdht.js";

test("publisher seed and derived Home public key are exactly 32 bytes", () => {
  const publisherSeed = generatePublisherSeed();
  const homeKey = derivePublisherHomeKey(publisherSeed);

  assert.match(publisherSeed, /^[0-9a-f]{64}$/);
  assert.match(homeKey, /^[0-9a-f]{64}$/);
});

test("generated client identity has a HyperDHT-compatible 32-byte public and 64-byte secret key", () => {
  const identity = generateClientIdentity();

  assert.match(identity.publicKey, /^[0-9a-f]{64}$/);
  assert.match(identity.secretKey, /^[0-9a-f]{128}$/);
  assert.deepEqual(parseClientIdentity(identity), identity);
});

test("HyperDHT reconstructs a key pair from the retained secret key", () => {
  const identity = generateClientIdentity();
  const keyPair = keyPairFromSecretKey(identity.secretKey);

  assert.equal(Buffer.from(keyPair.publicKey).toString("hex"), identity.publicKey);
  assert.equal(Buffer.from(keyPair.secretKey).toString("hex"), identity.secretKey);
});

test("client identity round-trips through its persisted JSON shape", () => {
  const identity = generateClientIdentity();

  assert.deepEqual(parseClientIdentity(JSON.parse(serializeClientIdentity(identity))), identity);
  assert.deepEqual(Object.keys(JSON.parse(serializeClientIdentity(identity))).sort(), [
    "publicKey",
    "secretKey",
  ]);
});

test("client identity rejects a public key that does not match the seed portion of its secret key", () => {
  const identity = generateClientIdentity();
  const otherIdentity = generateClientIdentity();

  assert.throws(
    () => parseClientIdentity({ ...identity, publicKey: otherIdentity.publicKey }),
    /publicKey|identity/i,
  );
});

test("client identity rejects a secret key whose trailing bytes do not match the derived keypair", () => {
  const identity = generateClientIdentity();
  const lastByte = identity.secretKey.slice(-2) === "00" ? "01" : "00";

  assert.throws(
    () => parseClientIdentity({ ...identity, secretKey: identity.secretKey.slice(0, -2) + lastByte }),
    /secretKey|identity/i,
  );
});
