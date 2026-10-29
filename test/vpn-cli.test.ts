import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createDefaultCliDependencies, runCli } from "../src/cli/main.js";
import { loadKeposConfig } from "../src/app-config.js";

test("setup, key and pair preserve VPN and network settings", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kepos-cli-"));
  const state = path.join(root, "peer"), config = path.join(root, "config.toml");
  const lines: string[] = [];
  const deps = createDefaultCliDependencies({ stdout: (line) => lines.push(line) });
  try {
    await runCli(["setup", "peer", "--state", state, "--config", config], deps);
    await runCli(["peer", "key", "--state", state], deps);
    assert.equal(lines[0], lines[1]);
    const firstKey = "ab".repeat(32), secondKey = "cd".repeat(32);
    await writeFile(config, `[[peers]]\nlabel = "first"\npublic_key = "${firstKey}"\nconnection = "dial"\n\n[network]\nbootstrap = ["example.test:1234"]\nroute = "public"\n\n[vpn]\naddress = "198.18.0.1"\npeers = [{ peer = "first", address = "198.18.0.2", allow_tcp = [443] }]\n`);
    const before = await loadKeposConfig(config);
    await runCli(["peer", "pair", "--config", config, "--label", "second", "--public-key", secondKey, "--connection", "accept"], deps);
    const after = await loadKeposConfig(config);
    assert.deepEqual(after?.vpn, before?.vpn);
    assert.deepEqual(after?.network, before?.network);
    assert.equal(after?.peers.length, 2);
    await assert.rejects(runCli(["peer", "pair", "--config", config, "--label", "first", "--public-key", secondKey], deps), /different peer/);
    assert.deepEqual(await loadKeposConfig(config), after);
    assert.equal((await readFile(config, "utf8")).includes("services"), false);
    await assert.rejects(runCli(["peer", "convert"], deps), /unknown command/);
    await assert.rejects(runCli(["peer", "run"], deps), /unknown command/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
