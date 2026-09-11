import assert from "node:assert/strict";
import { test } from "node:test";

import { parsePeerConfig, type PeerConfig } from "../src/config.js";

const peerKey = "ab".repeat(32);
const otherPeerKey = "cd".repeat(32);

function baseConfig(): PeerConfig {
  return parsePeerConfig({
    network: {
      bootstrap: [{ host: "127.0.0.1", port: 49_737 }],
      route: "public",
    },
    gateway: { port: 0, host: "127.0.0.1", domain: "Peers.Example" },
    peers: [
      { label: "phone", publicKey: peerKey, connection: "dial" },
      { label: "nuc", publicKey: otherPeerKey, connection: "accept" },
    ],
    services: [
      {
        id: "ssh",
        name: "SSH",
        source: { localPort: 22 },
        allow: [peerKey],
      },
      {
        id: "cua",
        name: "CUA driver",
        kind: "http",
        source: { unixSocket: "/tmp/kepos-cua.sock" },
        allow: [otherPeerKey],
        maxPublisherToSubscriberBps: 2_000_000,
      },
      {
        id: "remote-ssh",
        name: "Remote SSH",
        source: { peer: "nuc", service: "ssh" },
        allow: [],
      },
    ],
    bindings: [
      { peer: "nuc", service: "ssh", listen: { localPort: 0 } },
      {
        peer: peerKey,
        service: "cua",
        listen: { unixSocket: "/tmp/kepos-cua-binding.sock" },
      },
    ],
  });
}

test("canonical config parses all peer, service, binding, and network variants", () => {
  const config = baseConfig();
  assert.deepEqual(config.peers[0], {
    label: "phone",
    publicKey: peerKey,
    connection: "dial",
  });
  assert.deepEqual(config.services[1], {
    id: "cua",
    name: "CUA driver",
    kind: "http",
    source: { unixSocket: "/tmp/kepos-cua.sock" },
    allow: [otherPeerKey],
    maxPublisherToSubscriberBps: 2_000_000,
  });
  assert.deepEqual(config.bindings[1]?.listen, {
    unixSocket: "/tmp/kepos-cua-binding.sock",
  });
  assert.equal(config.network?.route, "public");
});

test("canonical config rejects old role fields and unknown fields", () => {
  const minimal = { peers: [], services: [], bindings: [] };
  for (const value of [
    null,
    [],
    { ...minimal, publisher: {} },
    { ...minimal, subscriber: {} },
    { ...minimal, peers: undefined },
    { ...minimal, services: undefined },
    { ...minimal, bindings: undefined },
  ]) {
    assert.throws(() => parsePeerConfig(value), /config|unknown|array|object/i);
  }

  assert.throws(
    () => parsePeerConfig({ ...minimal, peers: [{ label: "x", publicKey: peerKey, connection: "listen" }] }),
    /connection/i,
  );
  assert.throws(
    () => parsePeerConfig({ ...minimal, peers: [{ label: "x", publicKey: peerKey, connection: "accept", extra: true }] }),
    /unknown/i,
  );
  assert.throws(
    () => parsePeerConfig({ ...minimal, services: [{ id: "home", name: "Home", source: { localPort: 22 } }] }),
    /reserved/i,
  );
});

test("canonical config keeps endpoint variants exclusive and bounded", () => {
  const minimal = { peers: [], services: [], bindings: [] };
  assert.throws(
    () => parsePeerConfig({ ...minimal, services: [{ id: "ssh", name: "SSH", source: { localPort: 22, unixSocket: "/tmp/x" } }] }),
    /exactly one/i,
  );
  assert.throws(
    () => parsePeerConfig({ ...minimal, services: [{ id: "ssh", name: "SSH", source: { peer: "x" } }] }),
    /peer source/i,
  );
  assert.throws(
    () => parsePeerConfig({ ...minimal, services: [{ id: "ssh", name: "SSH", source: { localPort: 0 } }] }),
    /localPort/i,
  );
  assert.throws(
    () => parsePeerConfig({ ...minimal, services: [{ id: "ssh", name: "SSH", source: { unixSocket: "relative.sock" } }] }),
    /absolute/i,
  );
  assert.throws(
    () => parsePeerConfig({ ...minimal, bindings: [{ peer: peerKey, service: "ssh", listen: { localPort: 65_536 } }] }),
    /localPort/i,
  );
  assert.deepEqual(
    parsePeerConfig({
      peers: [{ label: "phone", publicKey: peerKey, connection: "accept" }],
      services: [],
      bindings: [{
        peer: peerKey,
        service: "ssh",
        kind: "udp",
        listen: { localPort: 0 },
      }],
    }).bindings[0],
    {
      peer: peerKey,
      service: "ssh",
      kind: "udp",
      listen: { localPort: 0 },
    },
  );
  assert.throws(
    () => parsePeerConfig({ ...minimal, bindings: [{ peer: peerKey, service: "ssh", kind: "other", listen: { localPort: 0 } }] }),
    /kind/i,
  );
  assert.throws(
    () => parsePeerConfig({ ...minimal, bindings: [{ peer: peerKey, service: "ssh", kind: "udp", listen: { unixSocket: "/tmp/udp.sock" } }] }),
    /UDP|Unix/i,
  );
  assert.throws(
    () => parsePeerConfig({ ...minimal, services: [{ id: "ssh", name: "SSH", kind: "udp", source: { unixSocket: "/tmp/udp.sock" } }] }),
    /UDP|Unix/i,
  );
});

test("canonical config validates references, grants, uniqueness, and policies", () => {
  const minimal = { peers: [{ label: "phone", publicKey: peerKey, connection: "accept" }], services: [], bindings: [] };
  assert.throws(
    () => parsePeerConfig({ ...minimal, services: [{ id: "ssh", name: "SSH", source: { peer: "missing", service: "x" } }] }),
    /unknown peer/i,
  );
  assert.throws(
    () => parsePeerConfig({ ...minimal, services: [{ id: "ssh", name: "SSH", source: { localPort: 22 }, allow: [otherPeerKey] }] }),
    /allow.*unknown|unknown peer/i,
  );
  assert.throws(
    () => parsePeerConfig({ ...minimal, bindings: [{ peer: "phone", service: "ssh", listen: { localPort: 0 } }, { peer: peerKey, service: "ssh", listen: { localPort: 0 } }] }),
    /duplicate service binding/i,
  );
  assert.throws(
    () => parsePeerConfig({ ...minimal, peers: [{ label: "phone", publicKey: peerKey, connection: "accept" }, { label: "phone", publicKey: otherPeerKey, connection: "accept" }] }),
    /duplicate peer label/i,
  );
  assert.throws(
    () => parsePeerConfig({ ...minimal, services: [{ id: "ssh", name: "SSH", source: { localPort: 22 }, maxPublisherToSubscriberBps: 0 }] }),
    /positive/i,
  );
});

test("canonical config rejects malformed scalar boundaries before runtime use", () => {
  const minimal = { peers: [], services: [], bindings: [] };
  const withPeer = {
    peers: [{ label: "phone", publicKey: peerKey, connection: "accept" }],
    services: [],
    bindings: [],
  };

  assert.throws(
    () => parsePeerConfig({ ...minimal, peers: [{ label: "phone", publicKey: "bad", connection: "accept" }] }),
    /32 bytes/,
  );
  assert.throws(
    () => parsePeerConfig({ ...minimal, peers: [{ label: "", publicKey: peerKey, connection: "accept" }] }),
    /label/,
  );
  assert.throws(
    () => parsePeerConfig({ ...minimal, peers: [{ label: " phone", publicKey: peerKey, connection: "accept" }] }),
    /label/,
  );
  assert.throws(
    () => parsePeerConfig({ ...minimal, peers: [{ label: "\u0001", publicKey: peerKey, connection: "accept" }] }),
    /label/,
  );
  assert.throws(
    () => parsePeerConfig({ ...minimal, peers: [{ label: "x".repeat(129), publicKey: peerKey, connection: "accept" }] }),
    /label/,
  );
  assert.throws(
    () => parsePeerConfig({ ...minimal, services: [{ id: "ssh", name: "SSH", source: { localPort: "22" } }] }),
    /localPort/,
  );
  assert.throws(
    () => parsePeerConfig({ ...minimal, services: [{ id: "ssh", name: "SSH", source: { localPort: 1.5 } }] }),
    /localPort/,
  );
  assert.throws(
    () => parsePeerConfig({ ...minimal, services: [{ id: "ssh", name: "SSH", source: { localPort: -1 } }] }),
    /localPort/,
  );
  assert.throws(
    () => parsePeerConfig({ ...minimal, services: [{ id: "ssh", name: "SSH", source: { localPort: 65_536 } }] }),
    /localPort/,
  );
  assert.throws(
    () => parsePeerConfig({ ...minimal, services: [{ id: "ssh", name: "SSH", source: { unixSocket: "/tmp/a\u0000.sock" } }] }),
    /absolute|socket/,
  );
  assert.throws(
    () => parsePeerConfig({ ...minimal, services: [{ id: "ssh", name: "SSH", source: { unixSocket: `/${"x".repeat(103)}` } }] }),
    /103/,
  );
  assert.throws(
    () => parsePeerConfig({ ...withPeer, services: [{ id: "ssh", name: "SSH", source: { peer: "phone", service: "ssh" }, allow: "bad" }] }),
    /allow/,
  );
  assert.throws(
    () => parsePeerConfig({ ...withPeer, services: [{ id: "ssh", name: "SSH", source: { peer: "phone", service: "ssh" }, allow: [peerKey, peerKey] }] }),
    /duplicate/,
  );
  assert.throws(
    () => parsePeerConfig({ ...minimal, services: [{ id: "ssh", name: "", source: { localPort: 22 } }] }),
    /name/,
  );
  assert.throws(
    () => parsePeerConfig({ ...minimal, services: [{ id: "ssh", name: "SSH", kind: "other", source: { localPort: 22 } }] }),
    /kind/,
  );
  assert.throws(
    () => parsePeerConfig({ ...minimal, services: [{ id: "ssh", name: "SSH", source: { localPort: 22 }, maxPublisherToSubscriberBps: 1.5 }] }),
    /positive/,
  );
  assert.throws(
    () => parsePeerConfig({ ...minimal, services: [{ id: "ssh", name: "SSH", source: { localPort: 22 }, extra: true }] }),
    /unknown/,
  );
  assert.throws(
    () => parsePeerConfig({ ...withPeer, services: [{ id: "ssh", name: "SSH", source: { peer: "phone" } }] }),
    /peer source/,
  );
  assert.throws(
    () => parsePeerConfig({ ...withPeer, bindings: [{ peer: "", service: "ssh", listen: { localPort: 0 } }] }),
    /peer/,
  );
  assert.throws(
    () => parsePeerConfig({ ...withPeer, bindings: [{ peer: "phone", service: "ssh", listen: { localPort: -1 } }] }),
    /localPort/,
  );
  assert.throws(
    () => parsePeerConfig({ ...minimal, network: { bootstrap: "bad" } }),
    /bootstrap/,
  );
  assert.throws(
    () => parsePeerConfig({ ...minimal, network: { bootstrap: [{}] } }),
    /host/,
  );
  assert.throws(
    () => parsePeerConfig({ ...minimal, network: { bootstrap: [{ host: "x", port: 0 }] } }),
    /port/,
  );
  assert.throws(
    () => parsePeerConfig({ ...minimal, network: { route: "private" } }),
    /route/,
  );
  assert.throws(
    () => parsePeerConfig({ ...minimal, gateway: { port: -1 } }),
    /gateway.port/,
  );
  assert.throws(
    () => parsePeerConfig({ ...minimal, gateway: { host: "" } }),
    /gateway.host/,
  );
  assert.throws(
    () => parsePeerConfig({ ...minimal, gateway: { domain: "" } }),
    /gateway.domain/,
  );
});
