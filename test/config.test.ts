import assert from "node:assert/strict";
import { test } from "node:test";

import {
  parsePublisherIdentity,
  parsePublisherService,
  parsePublisherServices,
  parseSubscriberContact,
  serializePublisherIdentity,
  serializeSubscriberContact,
} from "../src/config.js";

const publicKey = "11".repeat(32);
const otherPublicKey = "22".repeat(32);
const seed = "33".repeat(32);

test("publisher identity round-trips one strict seed", () => {
  const identity = { seed };
  assert.deepEqual(
    parsePublisherIdentity(JSON.parse(serializePublisherIdentity(identity))),
    identity,
  );
  assert.deepEqual(Object.keys(JSON.parse(serializePublisherIdentity(identity))), [
    "seed",
  ]);
});

for (const [name, value] of [
  ["missing seed", {}],
  ["null", null],
  ["non-object", seed],
  ["extra field", { seed, subscribers: [] }],
  ["malformed seed", { seed: "ff".repeat(31) }],
  ["uppercase seed", { seed: "ab".repeat(32).toUpperCase() }],
] as const) {
  test(`publisher identity rejects ${name}`, () => {
    assert.throws(() => parsePublisherIdentity(value), /identity|seed|field/i);
  });
}

test("publisher service parser preserves TCP and HTTP policy", () => {
  assert.deepEqual(
    parsePublisherServices([
      { id: "ssh", name: "SSH", targetPort: 22 },
      {
        id: "web",
        name: "Web",
        kind: "http",
        targetPort: 8080,
        allow: [publicKey],
      },
    ]),
    [
      { id: "ssh", name: "SSH", kind: "tcp", targetPort: 22 },
      {
        id: "web",
        name: "Web",
        kind: "http",
        targetPort: 8080,
        allow: [publicKey],
      },
    ],
  );
  assert.deepEqual(
    parsePublisherService({ id: "other", name: "Other", targetPort: 1 }),
    { id: "other", name: "Other", kind: "tcp", targetPort: 1 },
  );
});

test("publisher services reject duplicate, reserved, or unsafe identifiers", () => {
  const service = { id: "ssh", name: "SSH", targetPort: 22 };
  for (const services of [
    [service, service],
    [{ ...service, id: "home" }],
    [{ ...service, id: "../ssh" }],
  ]) {
    assert.throws(
      () => parsePublisherServices(services),
      /service|id|duplicate|reserved/i,
    );
  }
});

test("publisher services reject arbitrary targets and malformed allowlists", () => {
  const base = { id: "ssh", name: "SSH", targetPort: 22 };
  assert.throws(
    () => parsePublisherService({ ...base, targetHost: "0.0.0.0" }),
    /field|targetHost/i,
  );
  assert.throws(
    () => parsePublisherService({ ...base, targetPort: 0 }),
    /targetPort/i,
  );
  assert.throws(
    () => parsePublisherService({ ...base, allow: ["ab".repeat(32).toUpperCase()] }),
    /allow/i,
  );
});

test("subscriber contact round-trips one pinned publisher key", () => {
  const contact = {
    publisherKey: publicKey,
    label: "Local Publisher",
    requestedLocalPort: 0,
  };

  assert.deepEqual(
    parseSubscriberContact(JSON.parse(serializeSubscriberContact(contact))),
    contact,
  );
});
