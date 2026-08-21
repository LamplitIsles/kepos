import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";

import {
  HomeRegistryTimeoutError,
  readHomeRegistry,
} from "../src/runtime/registry-client.js";
import {
  AndroidRegistryState,
  createAndroidRegistrySnapshot,
} from "../src/android/services.js";
import { createAndroidSubscriberServices } from "../src/android/worklet/services.js";
import type { HomeRegistry } from "../src/home/registry.js";
import { startHomeServer } from "../src/home/server.js";

const publisherKey = "ab".repeat(32);

test("Android registry snapshot applies shared service actions, icons, URLs, and order", () => {
  const registry: HomeRegistry = {
    schemaVersion: 2,
    revision: 1,
    publisher: { displayName: "kosmos", publisherKey },
    services: [
      { id: "home", name: "Home", kind: "tcp" },
      { id: "navidrome", name: "Navidrome", kind: "tcp" },
      { id: "ente-storage", name: "Ente Storage", kind: "tcp" },
      { id: "ssh", name: "SSH", kind: "tcp" },
      { id: "forgejo", name: "Forgejo", kind: "tcp" },
      { id: "ente", name: "Ente Photos", kind: "tcp" },
      { id: "woodpecker", name: "Woodpecker", kind: "tcp" },
    ],
  };

  assert.deepEqual(createAndroidRegistrySnapshot(registry, 17_480), {
    publisher: { displayName: "kosmos", publisherKey },
    services: [
      {
        id: "forgejo",
        name: "Forgejo",
        access: "http",
        action: "open",
        icon: "git",
        url: "http://forgejo.localhost:17480/",
      },
      {
        id: "woodpecker",
        name: "Woodpecker",
        access: "http",
        action: "open",
        icon: "build",
        url: "http://woodpecker.localhost:17480/",
      },
      {
        id: "navidrome",
        name: "Navidrome",
        access: "http",
        action: "copy-url",
        icon: "music",
        url: "http://navidrome.localhost:17480",
        copyText: "http://navidrome.localhost:17480",
      },
      {
        id: "ente-storage",
        name: "Ente Storage",
        access: "http",
        action: "copy-url",
        icon: "storage",
        url: "http://ente-storage.localhost:17480",
        copyText: "http://ente-storage.localhost:17480",
      },
      {
        id: "ente",
        name: "Ente Photos",
        access: "http",
        action: "copy-url",
        icon: "photos",
        url: "http://ente.localhost:17480",
        copyText: "http://ente.localhost:17480",
      },
    ],
  });
});

test("Android registry snapshot preserves publisher service order", () => {
  const registry: HomeRegistry = {
    schemaVersion: 2,
    revision: 1,
    publisher: { displayName: "studio", publisherKey },
    services: [
      { id: "home", name: "Home", kind: "tcp" },
      { id: "woodpecker", name: "Woodpecker", kind: "tcp" },
      { id: "navidrome", name: "Music", kind: "tcp" },
    ],
  };

  assert.deepEqual(
    createAndroidRegistrySnapshot(registry, 18_480).services.map(
      ({ id }) => id,
    ),
    ["woodpecker", "navidrome"],
  );
});

test("Android gives unknown registry services an HTTP fallback", () => {
  const registry: HomeRegistry = {
    schemaVersion: 2,
    revision: 1,
    publisher: { displayName: "studio", publisherKey },
    services: [
      { id: "home", name: "Home", kind: "tcp" },
      { id: "postgres", name: "PostgreSQL", kind: "tcp" },
    ],
  };

  assert.deepEqual(createAndroidRegistrySnapshot(registry, 17_480).services, [
    {
      id: "postgres",
      name: "PostgreSQL",
      access: "http",
      action: "open",
      icon: "web",
      url: "http://postgres.localhost:17480/",
    },
  ]);
});

test("Android gives prototype-named registry services an HTTP fallback", () => {
  const registry: HomeRegistry = {
    schemaVersion: 2,
    revision: 1,
    publisher: { displayName: "studio", publisherKey },
    services: [
      { id: "constructor", name: "Constructor", kind: "tcp" },
    ],
  };

  assert.deepEqual(createAndroidRegistrySnapshot(registry, 17_480).services, [
    {
      id: "constructor",
      name: "Constructor",
      access: "http",
      action: "open",
      icon: "web",
      url: "http://constructor.localhost:17480/",
    },
  ]);
});

test("Android presents BookOrbit, Mihomo Dashboard, and Mihomo with dedicated actions", () => {
  const registry: HomeRegistry = {
    schemaVersion: 2,
    revision: 1,
    publisher: { displayName: "kosmos", publisherKey },
    services: [
      { id: "home", name: "Home", kind: "tcp" },
      { id: "navidrome", name: "Navidrome", kind: "tcp" },
      { id: "dsh", name: "DeepSeek Harness", kind: "tcp" },
      { id: "mihomo", name: "Mihomo", kind: "tcp" },
      { id: "bookorbit", name: "BookOrbit", kind: "tcp" },
      { id: "mihomo-dashboard", name: "Mihomo Dashboard", kind: "tcp" },
    ],
  };

  assert.deepEqual(
    createAndroidRegistrySnapshot(
      registry,
      17_480,
      new Map([
        ["mihomo", 17_890],
        ["dsh", 13_080],
      ]),
    ).services,
    [
      {
        id: "dsh",
        name: "DeepSeek Harness",
        access: "http",
        action: "open",
        icon: "terminal",
        url: "http://127.0.0.1:13080/",
      },
      {
        id: "bookorbit",
        name: "BookOrbit",
        access: "http",
        action: "open",
        icon: "book",
        url: "http://bookorbit.localhost:17480/",
      },
      {
        id: "mihomo-dashboard",
        name: "Mihomo Dashboard",
        access: "http",
        action: "open",
        icon: "dashboard",
        url: "http://mihomo-dashboard.localhost:17480/",
      },
      {
        id: "mihomo",
        name: "Mihomo",
        access: "tcp",
        action: "copy-url",
        icon: "proxy",
        copyText: "socks5://127.0.0.1:17890",
      },
      {
        id: "navidrome",
        name: "Navidrome",
        access: "http",
        action: "copy-url",
        icon: "music",
        url: "http://navidrome.localhost:17480",
        copyText: "http://navidrome.localhost:17480",
      },
    ],
  );
});

test("Android maps its fixed raw listeners to Mihomo, dsh, and OpenClaw", () => {
  assert.deepEqual(createAndroidSubscriberServices(17_890, 13_080, 18_789), [
    { id: "mihomo", localPort: 17_890 },
    { id: "dsh", localPort: 13_080 },
    { id: "openclaw", localPort: 18_789 },
  ]);
});

test("Android reads the publisher registry through its local HTTP surface", async () => {
  const home = await startHomeServer({
    publisherKey,
    displayName: "kosmos",
    services: [
      { id: "navidrome", name: "Navidrome", kind: "tcp" },
      { id: "forgejo", name: "Forgejo", kind: "tcp" },
    ],
  });

  try {
    assert.deepEqual(await readHomeRegistry(home.port), {
      schemaVersion: 2,
      revision: 1,
      publisher: { displayName: "kosmos", publisherKey },
      services: [
        { id: "home", name: "Home", kind: "tcp" },
        { id: "navidrome", name: "Navidrome", kind: "tcp" },
        { id: "forgejo", name: "Forgejo", kind: "tcp" },
      ],
    });
  } finally {
    await home.close();
  }
});

test("Home registry timeout has a stable error type", async () => {
  const server = createServer(() => undefined);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    await assert.rejects(
      readHomeRegistry(address.port, 5),
      (error) => error instanceof HomeRegistryTimeoutError,
    );
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test("Android retains known services while reconnecting and refreshes after recovery", () => {
  const state = new AndroidRegistryState();
  const registry: HomeRegistry = {
    schemaVersion: 2,
    revision: 1,
    publisher: { displayName: "kosmos", publisherKey },
    services: [
      { id: "home", name: "Home", kind: "tcp" },
      { id: "navidrome", name: "Navidrome", kind: "tcp" },
    ],
  };
  const snapshot = createAndroidRegistrySnapshot(registry, 17_480);

  assert.equal(state.shouldRefresh("connecting"), false);
  assert.equal(state.shouldRefresh("connected"), true);
  state.accept(snapshot);
  assert.equal(state.shouldRefresh("connected"), false);

  state.observeConnection("reconnecting");
  assert.deepEqual(state.snapshot(), snapshot);
  assert.equal(state.shouldRefresh("reconnecting"), false);
  assert.equal(state.shouldRefresh("connected"), true);
});

test("Android clears the previous publisher registry on reconfiguration", () => {
  const state = new AndroidRegistryState();
  const snapshot = createAndroidRegistrySnapshot({
    schemaVersion: 2,
    revision: 1,
    publisher: { displayName: "kosmos", publisherKey },
    services: [{ id: "home", name: "Home", kind: "tcp" }],
  }, 17_480);
  state.accept(snapshot);

  state.clear();

  assert.equal(state.snapshot(), undefined);
  assert.equal(state.shouldRefresh("connected"), true);
});
