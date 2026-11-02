import assert from "node:assert/strict";
import { checkDialerAddresses, openLinuxTun, routeContains } from "../src/vpn/linux-tun.js";
import { startVpn } from "../src/vpn/runtime.js";
import { setupPeer } from "../src/state/peer.js";
import type { DhtNode } from "../src/mux/hyperdht.js";
import type { PeerConfig } from "../src/config.js";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("managed peer routes reject overlapping physical networks but allow a default route", () => {
  assert.equal(routeContains("192.168.1.0/24", "192.168.1.88"), true);
  assert.equal(routeContains("192.168.1.88", "192.168.1.88"), true);
  assert.equal(routeContains("192.168.2.0/24", "192.168.1.88"), false);
  assert.equal(routeContains("default", "192.168.1.88"), false);
  assert.equal(routeContains("0.0.0.0/0", "192.168.1.88"), false);
});
test("missing helper fails clearly without opening an interface", { skip: process.platform !== "linux" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kepos-missing-helper-"));
  try {
    await assert.rejects(openLinuxTun({ helper: path.join(root, "missing"), address: "198.18.0.1", peerAddresses: [], dialerPeerAddresses: ["198.18.0.2"], checkAddresses: async () => {} }), /Cannot start TUN helper/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Linux VPN checks dialing addresses while allowing a same-address static accepting peer", { skip: process.platform !== "linux" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kepos-vpn-roles-"));
  const stateDir = path.join(root, "peer"), helper = path.join(root, "missing");
  const acceptKey = "ab".repeat(32), dialKey = "cd".repeat(32);
  const local = [{ name: "fixture0", address: "192.168.1.88" }];
  const routes = [{ dst: "198.18.0.2/32", dev: "fixture1", protocol: "static" }];
  const checks: Array<{ address: string; peers: readonly string[] }> = [];
  const openTun: NonNullable<Parameters<typeof startVpn>[0]["openTun"]> = (options) => openLinuxTun({ ...options, checkAddresses: async (address, peers) => {
    checks.push({ address, peers });
    await checkDialerAddresses(address, peers, { local, routes });
  } });
  const dht = {} as DhtNode;
  const accept: PeerConfig = { peers: [{ label: "incoming", publicKey: acceptKey, connection: "accept" }], vpn: { address: "192.168.1.88", peers: [{ peer: "incoming", address: "198.18.0.2", allowTcp: [] }] } };
  try {
    await setupPeer({ stateDir });
    await assert.rejects(startVpn({ stateDir, helper, config: accept, dht, openTun }), /Cannot start TUN helper/);
    assert.equal(checks.length, 0);
    const dial: PeerConfig = { ...accept, peers: [{ ...accept.peers[0]!, connection: "dial" }] };
    await assert.rejects(startVpn({ stateDir, helper, config: dial, dht, openTun }), /192\.168\.1\.88.*fixture0/);
    dial.vpn = { ...dial.vpn!, address: "198.18.0.3" };
    await assert.rejects(startVpn({ stateDir, helper, config: dial, dht, openTun }), /host route 198\.18\.0\.2\/32.*fixture1/);
    const mixed: PeerConfig = { peers: [...accept.peers, { label: "outgoing", publicKey: dialKey, connection: "dial" }], vpn: { address: "198.18.0.3", peers: [...accept.vpn!.peers, { peer: dialKey, address: "198.18.0.4", allowTcp: [] }] } };
    await assert.rejects(startVpn({ stateDir, helper, config: mixed, dht, openTun }), /Cannot start TUN helper/);
    assert.deepEqual(checks.at(-1), { address: "198.18.0.3", peers: ["198.18.0.4"] });
    mixed.vpn!.peers[1]!.address = "192.168.1.88";
    await assert.rejects(startVpn({ stateDir, helper, config: mixed, dht, openTun }), /192\.168\.1\.88.*fixture0/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
