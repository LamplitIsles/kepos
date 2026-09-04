import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  parsePublisherIdentity,
  parseSubscriberContact,
} from "../src/config.js";
import { replaceFileAtomically } from "../src/state/files.js";
import { derivePublisherHomeKey, parseClientIdentity } from "../src/keys.js";
import {
  ensurePublisher,
  loadPublisherIdentity,
  setupPublisher,
} from "../src/state/publisher.js";
import {
  loadSubscriberConnectionState,
  promoteSubscriberPendingPublisher,
  setSubscriberPendingPublisher,
  setSubscriberPublisher,
  setupSubscriber,
} from "../src/state/subscriber.js";

async function stateDirectory(name: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), `kepos-state-${name}-`));
  return path.join(root, "state");
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, "utf8")) as unknown;
}

test("file replacement keeps complete values and cleans failed attempts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kepos-replace-"));
  try {
    const destination = path.join(root, "config.toml");
    const source = path.join(root, "next.toml");
    await writeFile(destination, "previous");
    await writeFile(source, "next");

    await replaceFileAtomically(source, destination);
    assert.equal(await readFile(destination, "utf8"), "next");

    assert.deepEqual(await readdir(root), ["config.toml"]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("failed replacement leaves the existing destination untouched", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kepos-replace-failure-"));
  try {
    const destination = path.join(root, "config.toml");
    await writeFile(destination, "previous");

    await assert.rejects(
      () =>
        replaceFileAtomically(path.join(root, "missing.toml"), destination),
      { code: "ENOENT" },
    );
    assert.equal(await readFile(destination, "utf8"), "previous");
    assert.deepEqual(await readdir(root), ["config.toml"]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("subscriber state keeps the current identity file and replaces only its publisher contact", async () => {
  const stateDir = await stateDirectory("subscriber");
  const first = await setupSubscriber({ stateDir });
  const identityPath = path.join(stateDir, "client.identity.json");
  const identityBytes = await readFile(identityPath);

  assert.equal(first.created, true);
  assert.deepEqual(first, {
    created: true,
    configured: false,
    publicKey: first.publicKey,
  });
  assert.equal(
    parseClientIdentity(await readJson(identityPath)).publicKey,
    first.publicKey,
  );
  assert.deepEqual(await readdir(stateDir), ["client.identity.json"]);

  await setSubscriberPublisher({
    stateDir,
    label: "kosmos",
    publisherKey: "11".repeat(32),
  });

  assert.deepEqual(await setupSubscriber({ stateDir }), {
    created: false,
    configured: true,
    publicKey: first.publicKey,
  });
  await setSubscriberPublisher({
    stateDir,
    label: "nuc",
    publisherKey: "22".repeat(32),
  });

  assert.deepEqual(
    parseSubscriberContact(
      await readJson(path.join(stateDir, "publisher.contact.json")),
    ),
    {
      publisherKey: "22".repeat(32),
      label: "nuc",
      requestedLocalPort: 0,
    },
  );
  assert.deepEqual(await readFile(identityPath), identityBytes);
  if (process.platform !== "win32") {
    assert.equal((await stat(stateDir)).mode & 0o777, 0o700);
    assert.equal((await stat(identityPath)).mode & 0o777, 0o600);
  }
});

test("subscriber pairing persists only a pending publisher contact before approval", async () => {
  const stateDir = await stateDirectory("subscriber-pending");
  const setup = await setupSubscriber({ stateDir });
  await setSubscriberPendingPublisher({
    stateDir,
    label: "Kosmos",
    publisherKey: "11".repeat(32),
  });

  assert.deepEqual(await readdir(stateDir), [
    "client.identity.json",
    "publisher.pending.json",
  ]);
  const pending = await loadSubscriberConnectionState(stateDir);
  assert.equal(pending.identity.publicKey, setup.publicKey);
  assert.deepEqual({ contact: pending.contact, pending: pending.pending }, {
    contact: {
      publisherKey: "11".repeat(32),
      label: "Kosmos",
      requestedLocalPort: 0,
    },
    pending: true,
  });
  assert.doesNotMatch(
    await readFile(path.join(stateDir, "publisher.pending.json"), "utf8"),
    /token/i,
  );
  assert.equal((await setupSubscriber({ stateDir })).configured, true);

  await promoteSubscriberPendingPublisher(stateDir);
  assert.deepEqual(await readdir(stateDir), [
    "client.identity.json",
    "publisher.contact.json",
  ]);
  assert.equal((await loadSubscriberConnectionState(stateDir)).pending, false);
  await assert.rejects(
    () =>
      setSubscriberPendingPublisher({
        stateDir,
        label: "Other",
        publisherKey: "22".repeat(32),
      }),
    /already has an approved publisher/i,
  );
});

test("publisher setup creates one seed-only identity and reuses its key", async () => {
  const stateDir = await stateDirectory("publisher");
  const first = await setupPublisher({ stateDir });

  assert.equal(first.created, true);
  assert.deepEqual(await readdir(stateDir), ["publisher.json"]);
  assert.deepEqual(parsePublisherIdentity(await readJson(path.join(stateDir, "publisher.json"))), {
    seed: (await loadPublisherIdentity(stateDir)).seed,
  });
  assert.deepEqual(await setupPublisher({ stateDir }), {
    ...first,
    created: false,
  });
  assert.deepEqual(await ensurePublisher({ stateDir }), {
    ...first,
    created: false,
  });
});

test("concurrent publisher setup returns the winner identity to every caller", async () => {
  const stateDir = await stateDirectory("publisher-concurrent");
  const results = await Promise.all(
    Array.from({ length: 4 }, () => setupPublisher({ stateDir })),
  );

  assert.equal(results.filter(({ created }) => created).length, 1);
  assert.equal(new Set(results.map(({ publisherKey }) => publisherKey)).size, 1);
  assert.deepEqual(await readdir(stateDir), ["publisher.json"]);
  assert.equal(
    results[0]?.publisherKey,
    derivePublisherHomeKey((await loadPublisherIdentity(stateDir)).seed),
  );
});

test("publisher state rejects partial, extra, and malformed identities", async () => {
  const partial = await stateDirectory("publisher-partial");
  await mkdir(partial, { recursive: true, mode: 0o700 });
  await writeFile(path.join(partial, "publisher.manifest.json"), "{}");
  await assert.rejects(() => loadPublisherIdentity(partial), /partial or invalid state/);

  const extra = await stateDirectory("publisher-extra");
  await setupPublisher({ stateDir: extra });
  await writeFile(path.join(extra, "stale.json"), "{}");
  await assert.rejects(() => loadPublisherIdentity(extra), /partial or invalid state/);

  const malformed = await stateDirectory("publisher-malformed");
  await mkdir(malformed, { recursive: true, mode: 0o700 });
  await writeFile(path.join(malformed, "publisher.json"), JSON.stringify({ seed: "00" }), {
    mode: 0o600,
  });
  await assert.rejects(() => loadPublisherIdentity(malformed), /seed|invalid state/);
});
