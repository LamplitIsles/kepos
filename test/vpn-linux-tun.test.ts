import assert from "node:assert/strict";
import { test } from "node:test";
import { openLinuxTun } from "../src/vpn/linux-tun.js";

test("missing helper fails clearly without opening an interface", { skip: process.platform !== "linux" }, async () => {
  await assert.rejects(openLinuxTun({ helper: "/nonexistent-kepos-test-helper", address: "198.18.0.1", peerAddresses: [] }), /Cannot start TUN helper/);
});
