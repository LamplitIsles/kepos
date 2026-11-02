import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { PassThrough } from "node:stream";
import { createDefaultCliDependencies, runCli } from "../src/cli/main.js";
import { loadKeposConfig } from "../src/app-config.js";
import { getPeerPublicKey } from "../src/state/peer.js";
import { acquirePeerRuntimeLock } from "../src/runtime/runtime-lock.js";
import { checkDialerAddresses } from "../src/vpn/linux-tun.js";
import { PairError } from "../src/vpn/pair.js";
import { startVpn } from "../src/vpn/runtime.js";
import type { DhtNode } from "../src/mux/hyperdht.js";
import { readInvitation } from "../src/cli/invitation-input.js";

const receiverKey = "ab".repeat(32);
const invitation = "private-invitation-for-test";
const result = { peers: [{ label: "receiver", publicKey: receiverKey, connection: "dial" as const }], vpn: { address: "198.18.8.2", peers: [{ peer: "receiver", address: "192.168.1.88", allowTcp: [] }] } };

test("terminal invitation input is hidden and restores terminal mode", async () => {
  const input = new PassThrough() as unknown as NodeJS.ReadStream;
  const output = new PassThrough() as unknown as NodeJS.WriteStream;
  Object.assign(input, { isTTY: true, isRaw: false, setRawMode(mode: boolean) { this.isRaw = mode; return this; } });
  Object.assign(output, { isTTY: true });
  let visible = "";
  output.on("data", (chunk: Buffer) => { visible += chunk.toString(); });
  const pending = readInvitation(input, output);
  input.write(`${invitation}\r`);
  assert.equal(await pending, invitation);
  assert.equal(input.isRaw, false);
  assert(!visible.includes(invitation));
  input.destroy(); output.destroy();
});

test("join initializes or reuses identity, saves VPN-readable configuration, and protects existing state", { skip: process.platform !== "linux" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kepos-join-"));
  const state = path.join(root, "peer"), config = path.join(root, "config.toml");
  const output: string[] = [], keys: string[] = [];
  const deps = createDefaultCliDependencies({ stdout: (line) => output.push(line), stderr: (line) => output.push(line) });
  deps.readInvitation = async () => invitation;
  deps.checkDialerAddresses = async () => {};
  deps.pairWithReceiver = async (options) => { assert.equal(options.invitation, invitation); keys.push(Buffer.from(options.keyPair.publicKey).toString("hex")); return result; };
  const join = () => runCli(["peer", "join", "--state", state, "--config", config], deps);
  try {
    await join();
    assert.equal(keys[0], await getPeerPublicKey(state));
    assert.deepEqual(await loadKeposConfig(config), result);
    assert(!output.join(" ").includes(invitation));
    assert(!output.join(" ").includes((await readFile(path.join(state, "peer.json"), "utf8")).match(/[0-9a-f]{64}/)![0]));
    let tunCalled = false;
    const dht = { createServer: () => ({ listen: async () => {}, close: async () => {} }), connect: () => { throw new Error("offline fixture"); } } as unknown as DhtNode;
    const vpn = await startVpn({ stateDir: state, config: (await loadKeposConfig(config))!, helper: "unused", dht, openTun: async () => {
      tunCalled = true;
      return { name: "fake", packets: { send: async () => {}, receive: async () => {} }, closed: new Promise<Error>(() => {}), close: async () => {} };
    } });
    assert(tunCalled);
    await vpn.stop();
    const saved = await readFile(config, "utf8");
    await assert.rejects(join(), /already contains/);
    assert.equal(await readFile(config, "utf8"), saved);
    await writeFile(config, "peers = []\n");
    await join();
    assert.equal(keys[0], keys[1]);
    const lock = await acquirePeerRuntimeLock(state);
    try { await assert.rejects(join(), /already in use/); } finally { await lock.release(); }
    await rm(state, { recursive: true });
    await assert.rejects(runCli(["setup", "peer", "--state", state, "--config", config], deps));
    await assert.rejects(join(), /already contains/);
    await assert.rejects(readFile(path.join(state, "peer.json")));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("manual setup, failed admission and post-commit failure preserve identity without replay", { skip: process.platform !== "linux" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kepos-join-failure-"));
  const state = path.join(root, "peer"), config = path.join(root, "config.toml");
  const deps = createDefaultCliDependencies({ stdout: () => {}, stderr: () => {} });
  deps.readInvitation = async () => invitation;
  deps.checkDialerAddresses = async () => {};
  const join = () => runCli(["peer", "join", "--state", state, "--config", config], deps);
  let calls = 0;
  try {
    await runCli(["setup", "peer", "--state", state, "--config", config], deps);
    const key = await getPeerPublicKey(state), before = await readFile(config, "utf8");
    for (const reason of ["unusable", "unavailable", "capacity", "unknown"] as const) {
      deps.pairWithReceiver = async () => { calls++; throw new PairError(reason); };
      await assert.rejects(join(), (error: Error) => {
        assert(!error.message.includes(invitation));
        if (reason === "unknown") assert.match(error.message, /may have admitted.*inspect peer devices.*do not replay/);
        return true;
      });
      assert.equal(await readFile(config, "utf8"), before);
    }
    assert.equal(calls, 4);
    deps.pairWithReceiver = async () => { calls++; return result; };
    deps.checkDialerAddresses = async () => { throw new Error("IPv4 address 198.18.8.2 is already assigned"); };
    await assert.rejects(join(), /accepted.*198\.18\.8\.2.*inspect peer devices/);
    deps.checkDialerAddresses = async () => {};
    deps.saveConfig = async () => { throw new Error("disk full"); };
    await assert.rejects(join(), /accepted.*disk full.*inspect peer devices/);
    assert.equal(calls, 6);
    assert.equal(await getPeerPublicKey(state), key);
    assert.equal(await readFile(config, "utf8"), before);
    deps.pairWithReceiver = async () => { calls++; await writeFile(config, "peers = []\n[network]\nroute = \"public\"\n"); return result; };
    await assert.rejects(join(), /accepted.*Config changed during pairing.*inspect peer devices/);
    assert.match(await readFile(config, "utf8"), /route = "public"/);
    await writeFile(path.join(state, "peer.json"), "broken");
    await assert.rejects(join(), /invalid state file/);
    assert.equal(calls, 7);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("address conflict snapshots reject exact local addresses and host routes but allow LAN routes", async () => {
  const local = [{ name: "eth0", address: "192.168.1.4" }];
  const routes = [{ dst: "192.168.1.0/24", dev: "eth0", protocol: "kernel" }, { dst: "default", dev: "eth0" }];
  await checkDialerAddresses("198.18.8.2", ["192.168.1.88"], { local, routes });
  await assert.rejects(checkDialerAddresses("192.168.1.4", [], { local, routes }), /192\.168\.1\.4.*eth0/);
  await assert.rejects(checkDialerAddresses("198.18.8.2", ["192.168.1.88"], { local, routes: [...routes, { dst: "192.168.1.88", dev: "other" }] }), /192\.168\.1\.88\/32.*other/);
});
