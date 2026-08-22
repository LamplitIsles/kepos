import assert from "node:assert/strict";
import {
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
  parsePublisherConfig,
  parsePublisherManifest,
  parseSubscriberContact,
} from "../src/config.js";
import { replaceFileAtomically } from "../src/state/files.js";
import { parseClientIdentity } from "../src/keys.js";
import {
  ensurePublisher,
  setPublisherAllowlist,
  setPublisherServices,
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

test("publisher setup permits deny-all and rejects a different repeated topology", async () => {
  const stateDir = await stateDirectory("publisher");
  const options = {
    stateDir,
    displayName: "kosmos",
    subscriberPublicKeys: [] as string[],
    services: [{ id: "ssh", name: "SSH", targetPort: 22 }],
  };
  const first = await setupPublisher(options);

  assert.equal(first.created, true);
  assert.deepEqual(
    parsePublisherConfig(
      await readJson(path.join(stateDir, "publisher.json")),
    ).allow,
    [],
  );
  assert.deepEqual(await setupPublisher(options), {
    ...first,
    created: false,
  });
  await assert.rejects(
    () =>
      setupPublisher({
        ...options,
        subscriberPublicKeys: ["11".repeat(32)],
      }),
    /allowlist|existing/i,
  );
  await assert.rejects(
    () =>
      setupPublisher({
        ...options,
        services: [{ id: "ssh", name: "SSH", targetPort: 2222 }],
      }),
    /topology|manifest|existing/i,
  );
});

test("desktop publisher ensure reuses state while TOML policy changes", async () => {
  const stateDir = await stateDirectory("publisher-desktop-policy");
  const initial = {
    stateDir,
    displayName: "kosmos",
    subscriberPublicKeys: ["11".repeat(32)],
    services: [{ id: "ssh", name: "SSH", targetPort: 22 }],
  };
  await setupPublisher(initial);
  const manifestBefore = await readFile(
    path.join(stateDir, "publisher.manifest.json"),
  );
  const configBefore = await readFile(path.join(stateDir, "publisher.json"));

  const ensured = await ensurePublisher({
    ...initial,
    displayName: "renamed in TOML",
    subscriberPublicKeys: ["22".repeat(32)],
    services: [{ id: "navidrome", name: "Navidrome", targetPort: 4533 }],
  });

  assert.deepEqual(ensured, {
    created: false,
    publisherKey: (await setupPublisher(initial)).publisherKey,
  });
  assert.deepEqual(
    await readFile(path.join(stateDir, "publisher.manifest.json")),
    manifestBefore,
  );
  assert.deepEqual(await readFile(path.join(stateDir, "publisher.json")), configBefore);
});

test("publisher allowlist and services replace independently without rotating its key", async () => {
  const stateDir = await stateDirectory("publisher-update");
  const setup = await setupPublisher({
    stateDir,
    displayName: "kosmos",
    subscriberPublicKeys: ["11".repeat(32)],
    services: [{ id: "ssh", name: "SSH", targetPort: 22 }],
  });
  const configPath = path.join(stateDir, "publisher.json");
  const seed = parsePublisherConfig(await readJson(configPath)).seed;

  await setPublisherAllowlist({
    stateDir,
    subscriberPublicKeys: [],
  });
  await setPublisherServices({
    stateDir,
    services: [
      { id: "navidrome", name: "Navidrome", targetPort: 4533 },
    ],
  });

  assert.deepEqual(parsePublisherConfig(await readJson(configPath)), {
    seed,
    allow: [],
  });
  assert.deepEqual(
    parsePublisherManifest(
      await readJson(path.join(stateDir, "publisher.manifest.json")),
    ).services,
    [
      {
        id: "navidrome",
        name: "Navidrome",
        kind: "tcp",
        targetPort: 4533,
      },
    ],
  );
  assert.equal(
    (
      await setupPublisher({
        stateDir,
        displayName: "kosmos",
        subscriberPublicKeys: [],
        services: [
          { id: "navidrome", name: "Navidrome", targetPort: 4533 },
        ],
      })
    ).publisherKey,
    setup.publisherKey,
  );

  await setPublisherServices({ stateDir, services: [] });
  assert.deepEqual(
    parsePublisherManifest(
      await readJson(path.join(stateDir, "publisher.manifest.json")),
    ).services,
    [],
  );
});
