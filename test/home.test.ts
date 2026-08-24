import assert from "node:assert/strict";
import { test } from "node:test";

import { createHomeRegistry } from "../src/home/registry.js";
import { startHomeServer } from "../src/home/server.js";

const publisherKey = "ab".repeat(32);

test("Home Registry binds services to one publisher key", () => {
  const registry = createHomeRegistry({
    publisherKey,
    displayName: "Local Publisher",
    services: [],
  });

  assert.deepEqual(registry, {
    schemaVersion: 2,
    revision: 1,
    publisher: {
      displayName: "Local Publisher",
      publisherKey,
    },
    services: [
      {
        id: "home",
        name: "Home",
        kind: "tcp",
      },
    ],
  });

  const serialized = JSON.stringify(registry);
  for (const forbiddenField of ["target", "host", "port", "command", "script", "clientKey", "seed", "secret"]) {
    assert.equal(serialized.includes(`\"${forbiddenField}\"`), false, forbiddenField);
  }
});

test("Home Registry rejects a malformed publisher key", () => {
  assert.throws(
    () =>
      createHomeRegistry({
        publisherKey: "not-a-publisher-key",
        displayName: "Local Publisher",
        services: [],
      }),
    /publisher key/i,
  );
});

test("Home Registry reports every service as TCP without exposing publisher-local targets", () => {
  const registry = createHomeRegistry({
    publisherKey,
    displayName: "kosmos",
    services: [
      { id: "navidrome", name: "Navidrome", kind: "tcp" },
      { id: "ssh", name: "SSH", kind: "tcp" },
    ],
  });

  assert.deepEqual(registry, {
    schemaVersion: 2,
    revision: 1,
    publisher: { displayName: "kosmos", publisherKey },
    services: [
      { id: "home", name: "Home", kind: "tcp" },
      { id: "navidrome", name: "Navidrome", kind: "tcp" },
      { id: "ssh", name: "SSH", kind: "tcp" },
    ],
  });
  const serialized = JSON.stringify(registry);
  for (const forbidden of ["targetPort", "targetHost", "config", "seed", "secret"]) {
    assert.equal(serialized.includes(`"${forbidden}"`), false, forbidden);
  }
});

test("Home Registry rejects duplicate, reserved, or malformed public services", () => {
  const ssh = { id: "ssh", name: "SSH", kind: "tcp" as const };
  const options = { publisherKey, displayName: "kosmos" };

  assert.throws(
    () => createHomeRegistry({ ...options, services: [ssh, ssh] }),
    /duplicate|service/i,
  );
  assert.throws(
    () =>
      createHomeRegistry({
        ...options,
        services: [{ ...ssh, id: "home" }],
      }),
    /reserved|service/i,
  );
  assert.throws(
    () =>
      createHomeRegistry({
        ...options,
        services: [{ ...ssh, id: "../ssh" }],
      }),
    /service|id/i,
  );
});

test("Home server exposes the configured Registry", async () => {
  const home = await startHomeServer({
    publisherKey,
    displayName: "kosmos",
    services: [{ id: "ssh", name: "SSH", kind: "tcp" }],
  });
  try {
    const response = await fetch(`${home.url}/.well-known/kepos/services.json`);
    assert.deepEqual(
      await response.json(),
      createHomeRegistry({
        publisherKey,
        displayName: "kosmos",
        services: [{ id: "ssh", name: "SSH", kind: "tcp" }],
      }),
    );
  } finally {
    await home.close();
  }
});

async function withHome(run: (home: Awaited<ReturnType<typeof startHomeServer>>) => Promise<void>): Promise<void> {
  const home = await startHomeServer({ publisherKey });
  try {
    await run(home);
  } finally {
    await home.close();
  }
}

test("Home server binds only to an ephemeral loopback port", async () => {
  await withHome(async (home) => {
    assert.equal(home.host, "127.0.0.1");
    assert.equal(Number.isInteger(home.port), true);
    assert.equal(home.port > 0, true);
    assert.equal(home.url, `http://127.0.0.1:${home.port}`);
  });
});

test("Home server does not expose a human UI", async () => {
  await withHome(async (home) => {
    for (const pathname of ["/", "/styles.css"]) {
      const response = await fetch(`${home.url}${pathname}`);
      assert.equal(response.status, 404);
      assert.equal(response.headers.get("content-type"), "text/plain; charset=utf-8");
      assert.equal(await response.text(), "Not Found\n");
    }
  });
});

test("Home server serves the Registry with a content ETag", async () => {
  await withHome(async (home) => {
    const response = await fetch(`${home.url}/.well-known/kepos/services.json`);

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
    assert.match(response.headers.get("etag") ?? "", /^"[0-9a-f]{64}"$/);
    assert.deepEqual(
      await response.json(),
      createHomeRegistry({
        publisherKey,
        displayName: "Local Publisher",
        services: [],
      }),
    );
  });
});

test("Home server returns an empty 304 for a matching Registry ETag", async () => {
  await withHome(async (home) => {
    const first = await fetch(`${home.url}/.well-known/kepos/services.json`);
    const etag = first.headers.get("etag");
    assert.ok(etag);

    const response = await fetch(`${home.url}/.well-known/kepos/services.json`, {
      headers: { "if-none-match": etag },
    });

    assert.equal(response.status, 304);
    assert.equal(response.headers.get("etag"), etag);
    assert.equal(await response.text(), "");
  });
});

test("Home server refreshes Registry bodies and ETags", async () => {
  await withHome(async (home) => {
    const first = await fetch(`${home.url}/.well-known/kepos/services.json`);
    const oldEtag = first.headers.get("etag");
    assert.ok(oldEtag);

    home.updateRegistry?.({
      displayName: "Updated Publisher",
      services: [{ id: "ssh", name: "SSH", kind: "tcp" }],
    });
    const response = await fetch(`${home.url}/.well-known/kepos/services.json`, {
      headers: { "if-none-match": oldEtag },
    });
    const newEtag = response.headers.get("etag");

    assert.equal(response.status, 200);
    assert.notEqual(newEtag, oldEtag);
    assert.deepEqual(await response.json(), createHomeRegistry({
      publisherKey,
      displayName: "Updated Publisher",
      services: [{ id: "ssh", name: "SSH", kind: "tcp" }],
    }));
  });
});

test("Home server serves the health check as plain text", async () => {
  await withHome(async (home) => {
    const response = await fetch(`${home.url}/healthz`);

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/plain; charset=utf-8");
    assert.equal(await response.text(), "ok\n");
  });
});

test("Home server streams a bounded diagnostics download", async () => {
  await withHome(async (home) => {
    const response = await fetch(`${home.url}/.well-known/kepos/benchmark?bytes=1048576`);
    const body = await response.arrayBuffer();

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/octet-stream");
    assert.equal(response.headers.get("content-length"), "1048576");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-kepos-benchmark-bytes"), "1048576");
    assert.equal(body.byteLength, 1048576);
  });
});

test("Home server rejects an oversized diagnostics download", async () => {
  await withHome(async (home) => {
    const response = await fetch(`${home.url}/.well-known/kepos/benchmark?bytes=67108865`);

    assert.equal(response.status, 400);
    assert.match(await response.text(), /bytes/i);
  });
});

test("Home server returns plain-text 404 for every other path", async () => {
  await withHome(async (home) => {
    const response = await fetch(`${home.url}/missing`);

    assert.equal(response.status, 404);
    assert.equal(response.headers.get("content-type"), "text/plain; charset=utf-8");
    assert.equal(await response.text(), "Not Found\n");
  });
});
