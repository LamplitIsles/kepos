import assert from "node:assert/strict";
import { routeContains } from "../src/vpn/linux-tun.js";
import { test } from "node:test";

test("managed peer routes reject overlapping physical networks but allow a default route", () => {
  assert.equal(routeContains("192.168.1.0/24", "192.168.1.88"), true);
  assert.equal(routeContains("192.168.1.88", "192.168.1.88"), true);
  assert.equal(routeContains("192.168.2.0/24", "192.168.1.88"), false);
  assert.equal(routeContains("default", "192.168.1.88"), false);
  assert.equal(routeContains("0.0.0.0/0", "192.168.1.88"), false);
});
import { openLinuxTun } from "../src/vpn/linux-tun.js";

test("missing helper fails clearly without opening an interface", { skip: process.platform !== "linux" }, async () => {
  await assert.rejects(openLinuxTun({ helper: "/nonexistent-kepos-test-helper", address: "198.18.0.1", peerAddresses: [] }), /Cannot start TUN helper/);
});
