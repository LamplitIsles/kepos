import assert from "node:assert/strict";
import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  derivePublisherHomeKey,
  generateClientIdentity,
} from "../src/keys.js";
import {
  convertPeerIdentity,
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
    assert.equal(first.publicKey, derivePublisherHomeKey(identity.seed));
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

test("conversion requires the expected retained public key and preserves private permissions", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kepos-peer-convert-"));
  try {
    const source = path.join(root, "legacy-publisher");
    const destination = path.join(root, "peer");
    await mkdirPrivate(source);
    const publisher = await setupPeer({ stateDir: path.join(root, "generated") });
    const publisherIdentity = await loadPeerIdentity(path.join(root, "generated"));
    await writeFile(
      path.join(source, "publisher.json"),
      JSON.stringify({ seed: publisherIdentity.seed }),
      { mode: 0o600 },
    );
    const sourceFileBefore = await stat(path.join(source, "publisher.json"));
    const converted = await convertPeerIdentity({
      source,
      destination,
      expectedPublicKey: publisher.publicKey,
    });
    assert.deepEqual(converted, { destination, publicKey: publisher.publicKey });
    assert.deepEqual(await readdir(destination), ["peer.json"]);
    assert.deepEqual(await loadPeerIdentity(destination), publisherIdentity);
    if (process.platform !== "win32") {
      assert.equal((await stat(destination)).mode & 0o777, 0o700);
      assert.equal((await stat(path.join(destination, "peer.json"))).mode & 0o777, 0o600);
      assert.equal((await stat(path.join(source, "publisher.json"))).mode & 0o777, sourceFileBefore.mode & 0o777);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("conversion accepts one explicitly selected legacy client identity without preserving its schema", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kepos-peer-client-convert-"));
  try {
    const identity = generateClientIdentity();
    const source = path.join(root, "client.identity.json");
    const destination = path.join(root, "peer");
    await writeFile(source, `${JSON.stringify(identity)}\n`, { mode: 0o600 });
    const result = await convertPeerIdentity({
      source,
      destination,
      expectedPublicKey: identity.publicKey,
    });
    assert.equal(result.publicKey, identity.publicKey);
    assert.deepEqual(await loadPeerIdentity(destination), {
      seed: identity.secretKey.slice(0, 64),
    });
    assert.deepEqual(JSON.parse(await readFile(path.join(destination, "peer.json"), "utf8")), {
      seed: identity.secretKey.slice(0, 64),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("conversion rejects missing, invalid, mismatched, corrupt, and non-empty destinations before writing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kepos-peer-convert-errors-"));
  try {
    const generatedDir = path.join(root, "generated");
    const generated = await setupPeer({ stateDir: generatedDir });
    const identity = await loadPeerIdentity(generatedDir);
    const source = path.join(root, "publisher.json");
    await writeFile(source, JSON.stringify({ seed: identity.seed }), { mode: 0o600 });

    for (const expectedPublicKey of [
      undefined,
      "AB".repeat(32),
      "00".repeat(32),
    ]) {
      const destination = path.join(root, `rejected-${String(expectedPublicKey)}`);
      await assert.rejects(
        convertPeerIdentity({
          source,
          destination,
          expectedPublicKey: expectedPublicKey as unknown as string,
        }),
        /expected public key|match/i,
      );
      await assert.rejects(() => stat(destination), /ENOENT/);
    }

    const corrupt = path.join(root, "corrupt.json");
    await writeFile(corrupt, "{not-json", { mode: 0o600 });
    const corruptDestination = path.join(root, "corrupt-destination");
    await assert.rejects(
      convertPeerIdentity({
        source: corrupt,
        destination: corruptDestination,
        expectedPublicKey: generated.publicKey,
      }),
      /invalid legacy identity/i,
    );
    await assert.rejects(() => stat(corruptDestination), /ENOENT/);

    const existing = path.join(root, "existing");
    await writeFile(existing, "do not overwrite");
    await assert.rejects(
      convertPeerIdentity({
        source,
        destination: existing,
        expectedPublicKey: generated.publicKey,
      }),
      /already exists/i,
    );
    assert.equal(await readFile(existing, "utf8"), "do not overwrite");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function mkdirPrivate(directory: string): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(directory, { mode: 0o700, recursive: true });
  if (process.platform !== "win32") await chmod(directory, 0o700);
}
