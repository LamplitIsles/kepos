import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { derivePublisherHomeKey } from "../src/keys.js";
import {
  convertPeerIdentity,
  loadPeerIdentity,
  setupPeer,
} from "../src/state/peer.js";
import { setupPublisher } from "../src/state/publisher.js";
import { setupSubscriber } from "../src/state/subscriber.js";

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
    assert.deepEqual(JSON.parse(await readFile(path.join(stateDir, "peer.json"), "utf8")), {
      seed: identity.seed,
    });
    if (process.platform !== "win32") {
      assert.equal((await stat(stateDir)).mode & 0o777, 0o700);
      assert.equal((await stat(path.join(stateDir, "peer.json"))).mode & 0o777, 0o600);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("identity conversion is explicit, offline, and preserves publisher or subscriber keys", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kepos-peer-convert-"));
  try {
    const publisherSource = path.join(root, "publisher");
    const publisherDestination = path.join(root, "publisher-peer");
    const publisher = await setupPublisher({ stateDir: publisherSource });
    assert.deepEqual(
      await convertPeerIdentity({
        source: publisherSource,
        destination: publisherDestination,
        expectedPublicKey: publisher.publisherKey,
      }),
      { destination: publisherDestination, publicKey: publisher.publisherKey },
    );
    assert.deepEqual(await readdir(publisherDestination), ["peer.json"]);
    assert.equal(
      await readFile(path.join(publisherDestination, "peer.json"), "utf8"),
      await readFile(path.join(publisherSource, "publisher.json"), "utf8"),
    );

    const subscriberSource = path.join(root, "subscriber");
    const subscriberDestination = path.join(root, "subscriber-peer");
    const subscriber = await setupSubscriber({ stateDir: subscriberSource });
    const converted = await convertPeerIdentity({
      source: path.join(subscriberSource, "client.identity.json"),
      destination: subscriberDestination,
      expectedPublicKey: subscriber.publicKey,
    });
    assert.equal(converted.publicKey, subscriber.publicKey);
    assert.equal(
      (await loadPeerIdentity(subscriberDestination)).seed,
      (JSON.parse(await readFile(path.join(subscriberSource, "client.identity.json"), "utf8")) as { secretKey: string }).secretKey.slice(0, 64),
    );

    await assert.rejects(
      convertPeerIdentity({
        source: publisherSource,
        destination: publisherDestination,
      }),
      /destination already exists/i,
    );
    await assert.rejects(
      convertPeerIdentity({
        source: publisherSource,
        destination: path.join(publisherSource, "nested"),
      }),
      /outside the source/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
