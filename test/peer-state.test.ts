import assert from "node:assert/strict";
import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  derivePeerPublicKey,
} from "../src/keys.js";
import {
  loadPeerIdentity,
  setupPeer,
} from "../src/state/peer.js";

test("canonical peer state is seed-only, owner-only, and reusable", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kepos-peer-state-"));
  const stateDir = path.join(root, "peer");
  try {
    const first = await setupPeer({ stateDir });
    assert.equal(first.created, true);
    assert.deepEqual(await readdir(stateDir), ["peer.json"]);
    assert.deepEqual(await setupPeer({ stateDir }), {
      created: false,
      publicKey: first.publicKey,
    });
    const identity = await loadPeerIdentity(stateDir);
    assert.equal(first.publicKey, derivePeerPublicKey(identity.seed));
    assert.deepEqual(
      JSON.parse(await readFile(path.join(stateDir, "peer.json"), "utf8")),
      { seed: identity.seed },
    );
    if (process.platform !== "win32") {
      assert.equal((await stat(stateDir)).mode & 0o777, 0o700);
      assert.equal((await stat(path.join(stateDir, "peer.json"))).mode & 0o777, 0o600);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
