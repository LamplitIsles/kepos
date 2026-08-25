import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { parseKeposConfig, serializeKeposConfig } from "../src/app-config.js";
import { parsePublisherManifest } from "../src/config.js";
import { parsePublisherService } from "../src/cli/options.js";
import { loadPublisherState, setupPublisher } from "../src/state/publisher.js";

const subscriberKey = "11".repeat(32);

test("publisher manifest defaults a missing kind to TCP and accepts HTTP", () => {
  const base = {
    displayName: "publisher",
    publisherConfig: "publisher.json",
    services: [{ id: "site", name: "Site", targetPort: 8080 }],
  };
  assert.equal(parsePublisherManifest(base).services[0]?.kind, "tcp");
  assert.equal(
    parsePublisherManifest({
      ...base,
      services: [{ ...base.services[0], kind: "http" }],
    }).services[0]?.kind,
    "http",
  );
  assert.throws(
    () => parsePublisherManifest({ ...base, services: [{ ...base.services[0], kind: "udp" }] }),
    /tcp or http/,
  );
});

test("publisher state persists an HTTP kind while CLI omission remains TCP", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kepos-http-kind-"));
  try {
    const stateDir = path.join(root, "publisher");
    await setupPublisher({
      stateDir,
      displayName: "publisher",
      subscriberPublicKeys: [subscriberKey],
      services: [
        { id: "site", name: "Site", kind: "http", targetPort: 8080 },
        { id: "ssh", name: "SSH", targetPort: 22 },
      ],
    });
    const { manifest } = await loadPublisherState(stateDir);
    assert.deepEqual(manifest.services.map(({ id, kind }) => ({ id, kind })), [
      { id: "site", kind: "http" },
      { id: "ssh", kind: "tcp" },
    ]);
    assert.deepEqual(parsePublisherService("site:Site:8080:http"), {
      id: "site",
      name: "Site",
      targetPort: 8080,
      kind: "http",
    });
    assert.equal(parsePublisherService("ssh:SSH:22").kind, undefined);
    assert.throws(
      () => parsePublisherService("site:Site:8080:udp"),
      /kind must be tcp or http/,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("shared TOML retains explicit HTTP service classification", () => {
  const config = parseKeposConfig(`
[publisher]
display_name = "publisher"
allow = ["${subscriberKey}"]

[[publisher.services]]
id = "site"
name = "Site"
kind = "http"
target_port = 8080
`);
  assert.equal(config.publisher?.services[0]?.kind, "http");
  const source = serializeKeposConfig(config);
  assert.match(source, /kind = "http"/);
  assert.equal(parseKeposConfig(source).publisher?.services[0]?.kind, "http");
});
