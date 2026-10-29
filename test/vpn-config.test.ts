import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadKeposConfig, parseKeposConfig, saveKeposConfig, serializeKeposConfig } from "../src/app-config.js";
import { parsePeerConfig } from "../src/config.js";
import { defaultKeposConfigPath } from "../src/platform/paths.js";

const key = "ab".repeat(32);
const base = { peers: [{ label: "laptop", publicKey: key, connection: "dial" }] };

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

test("obsolete service configuration and unknown fields are rejected", () => {
  for (const field of ["services", "bindings", "gateway", "metrics"]) {
    assert.throws(() => parseKeposConfig(`peers = []\n${field} = []\n`), /unknown field/);
    assert.throws(() => parsePeerConfig({ peers: [], [field]: [] }), /unknown field/);
  }
  assert.throws(() => parseKeposConfig('peers = []\n[vpn]\naddress = "198.18.0.1"\npeers = []\nunknown = true\n'), /unknown field/);
});

test("peer definitions reject duplicate identities and malformed keys, labels, and directions", () => {
  const peer = { label: "laptop", publicKey: key, connection: "dial" };
  assert.throws(() => parsePeerConfig({ peers: [peer, { ...peer, publicKey: "cd".repeat(32) }] }), /duplicate peer label/);
  assert.throws(() => parsePeerConfig({ peers: [peer, { ...peer, label: "phone" }] }), /duplicate peer public key/);
  for (const publicKey of ["bad", "AB".repeat(32), "ab".repeat(31)]) {
    assert.throws(() => parsePeerConfig({ peers: [{ ...peer, publicKey }] }), /32 bytes of lowercase hex/);
  }
  for (const label of ["", " laptop", "laptop ", "\u0001", "x".repeat(129), "é".repeat(65)]) {
    assert.throws(() => parsePeerConfig({ peers: [{ ...peer, label }] }), /label/);
  }
  assert.throws(() => parsePeerConfig({ peers: [{ ...peer, connection: "listen" }] }), /connection/);
  assert.throws(() => parsePeerConfig({ peers: [{ ...peer, extra: true }] }), /unknown field/);
  assert.throws(() => parseKeposConfig(`[[peers]]\nlabel = "laptop"\npublicKey = "${key}"\nconnection = "dial"`), /unknown field/);
});

test("network configuration rejects malformed bootstrap and route values", () => {
  for (const network of [
    { bootstrap: "bad" },
    { bootstrap: [{}] },
    { bootstrap: [{ host: "example.test", port: 0 }] },
    { route: "private" },
  ]) assert.throws(() => parsePeerConfig({ peers: [], network }));
});

test("config saves privately and loads from an injected default path", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kepos-config-"));
  try {
    const environment = process.platform === "win32" ? { APPDATA: root } : { XDG_CONFIG_HOME: root };
    const configPath = defaultKeposConfigPath(environment, root, process.platform);
    assert.equal(await loadKeposConfig(undefined, environment, root, process.platform), undefined);
    const config = parsePeerConfig({
      ...base,
      network: { bootstrap: [{ host: "bootstrap.example", port: 49737 }], route: "public" },
      vpn: { address: "198.18.0.1", peers: [{ peer: "laptop", address: "198.18.0.2", allowTcp: [443] }] },
    });
    await saveKeposConfig(config, configPath);
    assert.deepEqual(await loadKeposConfig(undefined, environment, root, process.platform), config);
    assert.equal(await readFile(configPath, "utf8"), serializeKeposConfig(config));
    if (process.platform !== "win32") {
      assert.equal((await stat(configPath)).mode & 0o777, 0o600);
      assert.equal((await stat(path.dirname(configPath))).mode & 0o777, 0o700);
    }
    const updated = parsePeerConfig({ ...config, vpn: { ...config.vpn, peers: [] } });
    await saveKeposConfig(updated, configPath);
    assert.deepEqual(await loadKeposConfig(undefined, environment, root, process.platform), updated);
    if (process.platform !== "win32") assert.equal((await stat(configPath)).mode & 0o777, 0o600);
    await assert.rejects(() => loadKeposConfig(path.join(root, "missing.toml")), /Cannot read Kepos config/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
