import assert from "node:assert/strict";
import { test } from "node:test";

import {
  parsePublisherIdentity,
  parsePublisherService,
  parsePublisherServices,
  parsePeerConfig,
  parseSubscriberDevice,
  parseSubscriberDevices,
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

test("subscriber device lists validate bounded labels and unique identities", () => {
  const device = { publicKey, label: "phone" };
  assert.deepEqual(parseSubscriberDevice(device), device);
  assert.deepEqual(parseSubscriberDevices([device]), [device]);

  for (const value of [
    null,
    [],
    { ...device, extra: true },
    { ...device, publicKey: "not-a-key" },
    { ...device, label: "" },
    { ...device, label: " phone" },
    { ...device, label: "a".repeat(129) },
    { ...device, label: "line\nfeed" },
  ]) {
    assert.throws(() => parseSubscriberDevice(value), /device|label|key|field/i);
  }
  assert.throws(() => parseSubscriberDevices(null), /array/i);
  assert.throws(
    () => parseSubscriberDevices([device, { publicKey: otherPublicKey, label: device.label }]),
    /duplicate.*label/i,
  );
  assert.throws(
    () => parseSubscriberDevices([device, { publicKey, label: "another" }]),
    /duplicate.*key/i,
  );
});

test("legacy config parsers reject malformed values at each boundary", () => {
  assert.throws(() => parsePublisherService(null), /object/i);
  assert.throws(
    () => parsePublisherService({ id: "SSH", name: "SSH", source: { localPort: 22 } }),
    /identifier/i,
  );
  assert.throws(
    () => parsePublisherService({ id: "ssh", name: " ", source: { localPort: 22 } }),
    /name/i,
  );
  for (const localPort of ["22", 0, 65_536, 1.5]) {
    assert.throws(
      () => parsePublisherService({ id: "ssh", name: "SSH", source: { localPort } }),
      /localPort/i,
    );
  }
  assert.throws(
    () => parsePublisherService({ id: "ssh", name: "SSH", source: undefined }),
    /source/i,
  );
  assert.throws(
    () => parsePublisherService({ id: "ssh", name: "SSH", source: {} }),
    /source/i,
  );
  assert.throws(
    () => parsePublisherService({ id: "ssh", name: "SSH", source: { localPort: 22, extra: true } }),
    /unknown/i,
  );
  assert.throws(
    () => parsePublisherService({ id: "ssh", name: "SSH", source: { publisherKey: otherPublicKey, serviceId: "site", extra: true } }),
    /unknown/i,
  );
  assert.throws(
    () => parsePublisherService({ id: "ssh", name: "SSH", source: { publisherKey: "bad", serviceId: "site" } }),
    /publisherKey/i,
  );
  assert.throws(
    () => parsePublisherService({ id: "ssh", name: "SSH", source: { publisherKey: otherPublicKey, serviceId: "Site" } }),
    /serviceId/i,
  );
  assert.throws(
    () => parsePublisherService({ id: "ssh", name: "SSH", source: { localPort: 22 }, allow: "all" }),
    /allow/i,
  );
  assert.throws(
    () => parsePublisherServices(null),
    /array/i,
  );
  assert.throws(
    () => parseSubscriberContact({ publisherKey: publicKey, label: "phone", requestedLocalPort: -1 }),
    /requestedLocalPort/i,
  );
  assert.throws(
    () => parseSubscriberContact({ publisherKey: publicKey, label: " ", requestedLocalPort: 0 }),
    /label/i,
  );
  assert.throws(() => parseSubscriberContact(null), /contact|object/i);
});

test("canonical in-memory config rejects missing collections and malformed optional sections", () => {
  const minimal = { peers: [], services: [], bindings: [] };
  for (const value of [null, [], { ...minimal, extra: true }]) {
    assert.throws(() => parsePeerConfig(value), /config|unknown|object/i);
  }
  for (const field of ["peers", "services", "bindings"] as const) {
    const value = { ...minimal, [field]: undefined };
    assert.throws(() => parsePeerConfig(value), new RegExp(field));
  }
  assert.throws(() => parsePeerConfig({ ...minimal, network: null }), /network/i);
  assert.throws(() => parsePeerConfig({ ...minimal, gateway: null }), /gateway/i);
  assert.throws(
    () => parsePeerConfig({ ...minimal, network: { bootstrap: "not-an-array" } }),
    /bootstrap/i,
  );
  assert.throws(
    () => parsePeerConfig({ ...minimal, network: { bootstrap: [{ host: "", port: 1 }] } }),
    /host/i,
  );
  assert.throws(
    () => parsePeerConfig({ ...minimal, network: { bootstrap: [{ host: "dht", port: 0 }] } }),
    /port/i,
  );
  assert.throws(
    () => parsePeerConfig({ ...minimal, network: { route: "lan" } }),
    /route/i,
  );
  assert.throws(
    () => parsePeerConfig({ ...minimal, gateway: { port: 70_000 } }),
    /gateway\.port/i,
  );
  assert.throws(
    () => parsePeerConfig({ ...minimal, gateway: { host: "" } }),
    /gateway\.host/i,
  );
  assert.throws(
    () => parsePeerConfig({ ...minimal, gateway: { domain: "" } }),
    /gateway\.domain/i,
  );
});
