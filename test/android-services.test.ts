import assert from "node:assert/strict";
import { test } from "node:test";

import { readHomeRegistry } from "../src/runtime/registry-client.js";
import {
  AndroidRegistryState,
  createAndroidRegistrySnapshot,
} from "../src/android/services.js";
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

test("Android omits services without a built-in action", () => {
  const registry: HomeRegistry = {
    schemaVersion: 2,
    revision: 1,
    publisher: { displayName: "studio", publisherKey },
    services: [
      { id: "home", name: "Home", kind: "tcp" },
      { id: "postgres", name: "PostgreSQL", kind: "tcp" },
    ],
  };

  assert.deepEqual(createAndroidRegistrySnapshot(registry, 17_480).services, []);
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
