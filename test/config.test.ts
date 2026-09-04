import assert from "node:assert/strict";
import { test } from "node:test";

import {
  parseSubscriberContact,
  parsePublisherManifest,
  parsePublisherConfig,
  serializeSubscriberContact,
  serializePublisherManifest,
  serializePublisherConfig,
} from "../src/config.js";

const publicKey = "11".repeat(32);
const otherPublicKey = "22".repeat(32);
const seed = "33".repeat(32);

test("publisher config accepts an empty subscriber-device list as deny-all", () => {
  assert.deepEqual(parsePublisherConfig({ seed, subscribers: [] }), { seed, subscribers: [] });
});

test("publisher config round-trips seed and labeled subscriber devices", () => {
  const config = {
    seed,
    subscribers: [
      { label: "phone", publicKey },
      { label: "tablet", publicKey: otherPublicKey },
    ],
  };

  assert.deepEqual(parsePublisherConfig(JSON.parse(serializePublisherConfig(config))), config);
});

for (const [name, value] of [
  ["missing", { seed }],
  ["null", { seed, subscribers: null }],
  ["non-array", { seed, subscribers: publicKey }],
] as const) {
  test(`publisher config rejects ${name} subscribers instead of accepting fail-open state`, () => {
    assert.throws(() => parsePublisherConfig(value), /subscriber/i);
  });
}

for (const malformed of ["", "0", "gg".repeat(32), "aa".repeat(31), "AA".repeat(32)]) {
  test(`publisher config rejects malformed subscriber key ${JSON.stringify(malformed)}`, () => {
    assert.throws(
      () => parsePublisherConfig({ seed, subscribers: [{ label: "device", publicKey: malformed }] }),
      /publicKey|subscriber/i,
    );
  });
}

test("publisher config rejects malformed publisher seeds", () => {
  assert.throws(() => parsePublisherConfig({ seed: "ff".repeat(31), subscribers: [] }), /seed/i);
});

test("publisher config contains no separate publisher or person identity key", () => {
  const serialized = JSON.parse(serializePublisherConfig({ seed, subscribers: [{ label: "device", publicKey }] })) as Record<
    string,
    unknown
  >;

  assert.deepEqual(Object.keys(serialized).sort(), ["seed", "subscribers"]);
  assert.equal("publisherKey" in serialized, false);
  assert.equal("personKey" in serialized, false);
});

test("publisher config rejects fields outside the native seed and subscriber shape", () => {
  assert.throws(
    () => parsePublisherConfig({ seed, subscribers: [], secretKey: "ff".repeat(64) }),
    /field|property|shape/i,
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

test("publisher manifest round-trips one config and loopback TCP services", () => {
  const manifest = {
    displayName: "kosmos",
    publisherConfig: "publisher.json",
    services: [
      {
        id: "ssh",
        name: "SSH",
        kind: "tcp" as const,
        targetPort: 22,
      },
    ],
  };

  assert.deepEqual(
    parsePublisherManifest(JSON.parse(serializePublisherManifest(manifest))),
    manifest,
  );
});

test("publisher manifest rejects duplicate, reserved, or unsafe service identifiers", () => {
  const service = {
    id: "ssh",
    name: "SSH",
    kind: "tcp",
    targetPort: 22,
  };

  for (const services of [
    [service, service],
    [{ ...service, id: "home" }],
    [{ ...service, id: "../ssh" }],
  ]) {
    assert.throws(
      () =>
        parsePublisherManifest({
          displayName: "kosmos",
          publisherConfig: "publisher.json",
          services,
        }),
      /service|id|duplicate|reserved/i,
    );
  }
});

test("publisher manifest rejects arbitrary targets and unsafe config paths", () => {
  const base = {
    displayName: "kosmos",
    publisherConfig: "publisher.json",
    services: [
      {
        id: "ssh",
        name: "SSH",
        kind: "tcp",
        targetPort: 22,
      },
    ],
  };

  assert.throws(
    () =>
      parsePublisherManifest({
        ...base,
        services: [{ ...base.services[0], targetHost: "0.0.0.0" }],
      }),
    /field|targetHost/i,
  );
  assert.throws(
    () =>
      parsePublisherManifest({
        ...base,
        publisherConfig: "../publisher.json",
      }),
    /config/i,
  );
  assert.throws(
    () =>
      parsePublisherManifest({
        ...base,
        services: [{ ...base.services[0], targetPort: 0 }],
      }),
    /targetPort/i,
  );
});
