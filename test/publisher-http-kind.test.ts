import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { parseKeposConfig, serializeKeposConfig } from "../src/app-config.js";
import { parsePublisherIdentity, parsePublisherService } from "../src/config.js";
import { loadPublisherIdentity, setupPublisher } from "../src/state/publisher.js";

const subscriberKey = "11".repeat(32);

test("publisher service policy defaults TCP and accepts HTTP or UDP", () => {
  assert.equal(parsePublisherService({ id: "site", name: "Site", source: { localPort: 8080 } }).kind, "tcp");
  assert.equal(
    parsePublisherService({ id: "site", name: "Site", source: { localPort: 8080 }, kind: "http" }).kind,
    "http",
  );
  assert.equal(
    parsePublisherService({ id: "site", name: "Site", source: { localPort: 8080 }, kind: "udp" }).kind,
    "udp",
  );
});

test("publisher identity state contains no service policy", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kepos-http-kind-"));
  try {
    const stateDir = path.join(root, "publisher");
    await setupPublisher({
      stateDir,
    });
    const identity = await loadPublisherIdentity(stateDir);
    assert.deepEqual(Object.keys(identity), ["seed"]);
    assert.equal(parsePublisherIdentity(identity).seed.length, 64);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("shared TOML retains explicit HTTP service classification", () => {
  const config = parseKeposConfig(`
peers = [{ label = "subscriber", public_key = "${subscriberKey}", connection = "accept" }]
bindings = []

[[services]]
id = "site"
name = "Site"
kind = "http"
source = { local_port = 8080 }
allow = ["${subscriberKey}"]
`);
  assert.equal(config.services[0]?.kind, "http");
  const source = serializeKeposConfig(config);
  assert.match(source, /kind = "http"/);
  assert.equal(parseKeposConfig(source).services[0]?.kind, "http");
});
