import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  createDefaultCliDependencies,
  runCli,
} from "../src/cli/main.js";
import {
  startPublisher,
  type PublisherRuntimeStatus,
} from "../src/runtime/publisher.js";
import {
  startSubscriber,
  type SubscriberRuntimeStatus,
} from "../src/runtime/subscriber.js";
import { setupPublisher } from "../src/state/publisher.js";
import {
  setSubscriberPublisher,
  setupSubscriber,
} from "../src/state/subscriber.js";

interface HyperDhtTestnet {
  bootstrap: Array<{ host: string; port: number }>;
  destroy: () => Promise<void>;
}

type CreateHyperDhtTestnet = (size: number) => Promise<HyperDhtTestnet>;

const require = createRequire(import.meta.url);
const createHyperDhtTestnet = require(
  "hyperdht/testnet",
) as CreateHyperDhtTestnet;

test("publisher and subscriber expose synchronous status around an awaited lifecycle", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kepos-runtime-"));
  const publisherState = path.join(root, "publisher");
  const subscriberState = path.join(root, "subscriber");
  const output: string[] = [];
  const cli = createDefaultCliDependencies({
    stdout: (line) => output.push(line),
    stderr: (line) => output.push(line),
  });
  await runCli(
    ["setup", "subscriber", "--state", subscriberState],
    cli,
  );
  const subscriberKey = output.at(-1)?.split(": ")[1];
  assert.ok(subscriberKey);
  assert.match(subscriberKey, /^[0-9a-f]{64}$/);
  await runCli(
    [
      "setup",
      "publisher",
      "--state",
      publisherState,
      "--display-name",
      "kosmos",
      "--allow",
      subscriberKey,
    ],
    cli,
  );
  const publisherKey = output.at(-1)?.split(": ")[1];
  assert.ok(publisherKey);
  assert.match(publisherKey, /^[0-9a-f]{64}$/);
  await runCli(
    [
      "subscriber",
      "set-publisher",
      "--state",
      subscriberState,
      "--label",
      "kosmos",
      "--publisher-key",
      publisherKey,
    ],
    cli,
  );
  const testnet = await createHyperDhtTestnet(3);
  let publisher:
    | Awaited<ReturnType<typeof startPublisher>>
    | undefined;
  let subscriber:
    | Awaited<ReturnType<typeof startSubscriber>>
    | undefined;

  try {
    publisher = await startPublisher({
      stateDir: publisherState,
      bootstrap: testnet.bootstrap,
    });
    assert.deepEqual(publisher.status(), {
      role: "publisher",
      state: "running",
      publisherKey,
      homeUrl: publisher.home.url,
      acceptedConnections: 0,
      activeSubscribers: 0,
    } satisfies PublisherRuntimeStatus);

    subscriber = await startSubscriber({
      stateDir: subscriberState,
      bootstrap: testnet.bootstrap,
      gatewayPort: 0,
      services: [],
    });
    assert.deepEqual(subscriber.status(), {
      role: "subscriber",
      state: "running",
      connection: "connected",
      connectionGeneration: 1,
      publisherKey,
      homeUrl: subscriber.home.url,
      services: [],
    } satisfies SubscriberRuntimeStatus);
    assert.equal((await fetch(subscriber.home.url)).status, 200);
    assert.equal(publisher.status().activeSubscribers, 1);

    await subscriber.stop();
    assert.equal(subscriber.status().state, "stopped");
    await publisher.stop();
    assert.equal(publisher.status().state, "stopped");
  } finally {
    await Promise.allSettled([
      subscriber?.stop(),
      publisher?.stop(),
      testnet.destroy(),
      rm(root, { recursive: true, force: true }),
    ]);
  }
});

test("publisher runtime rejects state that the shared state loader rejects", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kepos-runtime-state-"));
  const stateDir = path.join(root, "publisher");
  await setupPublisher({
    stateDir,
    displayName: "kosmos",
    subscriberPublicKeys: [],
    services: [],
  });
  await writeFile(path.join(stateDir, "unexpected.json"), "{}");
  const testnet = await createHyperDhtTestnet(3);
  let publisher:
    | Awaited<ReturnType<typeof startPublisher>>
    | undefined;

  try {
    await assert.rejects(async () => {
      publisher = await startPublisher({
        stateDir,
        bootstrap: testnet.bootstrap,
      });
      await publisher.stop();
    }, /partial or invalid state/);
  } finally {
    await Promise.allSettled([
      publisher?.stop(),
      testnet.destroy(),
      rm(root, { recursive: true, force: true }),
    ]);
  }
});

test("publisher runtime policy overrides legacy state policy", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kepos-runtime-policy-"));
  const stateDir = path.join(root, "publisher");
  await setupPublisher({
    stateDir,
    displayName: "legacy",
    subscriberPublicKeys: [],
    services: [],
  });
  const testnet = await createHyperDhtTestnet(3);
  let publisher: Awaited<ReturnType<typeof startPublisher>> | undefined;

  try {
    publisher = await startPublisher({
      stateDir,
      bootstrap: testnet.bootstrap,
      policy: {
        displayName: "kosmos",
        allow: [],
        services: [
          { id: "navidrome", name: "Navidrome", targetPort: 4_533 },
        ],
      },
    });
    const registry = (await fetch(
      new URL("/.well-known/kepos/services.json", publisher.home.url),
    ).then((response) => response.json())) as {
      publisher: { displayName: string };
      services: Array<{ id: string }>;
    };
    assert.equal(registry.publisher.displayName, "kosmos");
    assert.deepEqual(
      registry.services.map(({ id }) => id),
      ["home", "navidrome"],
    );
  } finally {
    await Promise.allSettled([
      publisher?.stop(),
      testnet.destroy(),
      rm(root, { recursive: true, force: true }),
    ]);
  }
});

test("subscriber runtime rejects state that the shared state loader rejects", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kepos-runtime-state-"));
  const publisherState = path.join(root, "publisher");
  const subscriberState = path.join(root, "subscriber");
  const subscriber = await setupSubscriber({ stateDir: subscriberState });
  const publisher = await setupPublisher({
    stateDir: publisherState,
    displayName: "kosmos",
    subscriberPublicKeys: [subscriber.publicKey],
    services: [],
  });
  await setSubscriberPublisher({
    stateDir: subscriberState,
    label: "kosmos",
    publisherKey: publisher.publisherKey,
  });
  await writeFile(path.join(subscriberState, "unexpected.json"), "{}");
  const testnet = await createHyperDhtTestnet(3);
  let runningPublisher:
    | Awaited<ReturnType<typeof startPublisher>>
    | undefined;
  let runningSubscriber:
    | Awaited<ReturnType<typeof startSubscriber>>
    | undefined;

  try {
    runningPublisher = await startPublisher({
      stateDir: publisherState,
      bootstrap: testnet.bootstrap,
    });
    await assert.rejects(async () => {
      runningSubscriber = await startSubscriber({
        stateDir: subscriberState,
        bootstrap: testnet.bootstrap,
        gatewayPort: 0,
        services: [],
      });
      await runningSubscriber.stop();
    }, /partial or invalid state/);
  } finally {
    await Promise.allSettled([
      runningSubscriber?.stop(),
      runningPublisher?.stop(),
      testnet.destroy(),
      rm(root, { recursive: true, force: true }),
    ]);
  }
});
