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
      { id: "ssh", name: "SSH", source: { localPort: 22 } },
      {
        id: "web",
        name: "Web",
        kind: "http",
        source: { localPort: 8080 },
        allow: [publicKey],
        maxPublisherToSubscriberBps: 2_000_000,
      },
    ]),
    [
      { id: "ssh", name: "SSH", kind: "tcp", source: { localPort: 22 } },
      {
        id: "web",
        name: "Web",
        kind: "http",
        source: { localPort: 8080 },
        allow: [publicKey],
        maxPublisherToSubscriberBps: 2_000_000,
      },
    ],
  );
  assert.deepEqual(
    parsePublisherService({ id: "other", name: "Other", source: { localPort: 1 } }),
    { id: "other", name: "Other", kind: "tcp", source: { localPort: 1 } },
  );
});

test("publisher service parser accepts an explicit upstream source", () => {
  assert.deepEqual(
    parsePublisherService({
      id: "remote-site",
      name: "Remote site",
      kind: "http",
      source: { publisherKey: otherPublicKey, serviceId: "site" },
    }),
    {
      id: "remote-site",
      name: "Remote site",
      kind: "http",
      source: { publisherKey: otherPublicKey, serviceId: "site" },
    },
  );
});

test("publisher service parser rejects legacy and ambiguous sources", () => {
  const base = { id: "site", name: "Site" };
  for (const value of [
    { ...base, targetPort: 8080 },
    { ...base, source: { localPort: 8080, serviceId: "site" } },
    { ...base, source: { publisherKey: otherPublicKey } },
    { ...base, source: { serviceId: "site" } },
    {
      ...base,
      source: {
        publisherKey: otherPublicKey,
        serviceId: "Site",
      },
    },
  ]) {
    assert.throws(() => parsePublisherService(value), /source|field|identifier/i);
  }
});

test("publisher service parser rejects invalid outbound rate limits", () => {
  const base = { id: "ssh", name: "SSH", source: { localPort: 22 } };
  for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "2000000"]) {
    assert.throws(
      () => parsePublisherService({ ...base, maxPublisherToSubscriberBps: value }),
      /maxPublisherToSubscriberBps|positive|safe|integer/i,
    );
  }
  assert.throws(
    () =>
      parsePublisherService({
        ...base,
        max_publisher_to_subscriber_bps: 2_000_000,
      }),
    /unknown field/i,
  );
});

test("publisher services reject duplicate, reserved, or unsafe identifiers", () => {
  const service = { id: "ssh", name: "SSH", source: { localPort: 22 } };
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
  const base = { id: "ssh", name: "SSH", source: { localPort: 22 } };
  assert.throws(
    () => parsePublisherService({ ...base, targetHost: "0.0.0.0" }),
    /field|targetHost/i,
  );
  assert.throws(
    () => parsePublisherService({ ...base, source: { localPort: 0 } }),
    /localPort|source/i,
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
