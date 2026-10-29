import assert from "node:assert/strict";
import { test } from "node:test";
import { parseKeposConfig, serializeKeposConfig } from "../src/app-config.js";
import { parsePeerConfig } from "../src/config.js";

const key = "ab".repeat(32);
const base = { peers: [{ label: "laptop", publicKey: key, connection: "dial" }], services: [], bindings: [] };

test("VPN config round trips explicit addresses and deny-by-default port policy", () => {
  const config = parsePeerConfig({ ...base, vpn: { address: "198.18.0.1", peers: [{ peer: "laptop", address: "198.18.0.2" }] } });
  assert.deepEqual(config.vpn?.peers[0]?.allowTcp, []);
  assert.deepEqual(parseKeposConfig(serializeKeposConfig(config)), config);
  const allowed = parsePeerConfig({ ...base, vpn: { address: "198.18.0.1", peers: [{ peer: key, address: "198.18.0.2", allowTcp: "all" }] } });
  assert.deepEqual(parseKeposConfig(serializeKeposConfig(allowed)), allowed);
});

test("VPN config rejects ambiguous ownership and invalid policy", () => {
  for (const vpn of [
    { address: "127.0.0.1", peers: [] },
    { address: "10.01.0.1", peers: [] },
    { address: "10.0.0.1", peers: [{ peer: "laptop", address: "10.0.0.1" }] },
    { address: "10.0.0.1", peers: [{ peer: "missing", address: "10.0.0.2" }] },
    { address: "10.0.0.1", peers: [{ peer: "laptop", address: "10.0.0.2", allowTcp: [0] }] },
    { address: "10.0.0.1", peers: [{ peer: "laptop", address: "10.0.0.2", allowTcp: [443, 443] }] },
    { address: "10.0.0.1", peers: [{ peer: "laptop", address: "10.0.0.2" }, { peer: key, address: "10.0.0.3" }] },
  ]) assert.throws(() => parsePeerConfig({ ...base, vpn }));
});
