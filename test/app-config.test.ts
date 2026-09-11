import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  loadKeposConfig,
  parseKeposConfig,
  saveKeposConfig,
  serializeKeposConfig,
} from "../src/app-config.js";
import { parsePeerConfig, type PeerConfig } from "../src/config.js";
import {
  defaultKeposConfigPath,
  defaultKeposStateRoot,
} from "../src/platform/paths.js";

const peerKey = "11".repeat(32);
const otherPeerKey = "22".repeat(32);

test("canonical config parses peers, orthogonal transport settings, services, and bindings", () => {
  assert.deepEqual(
    parseKeposConfig(`
[network]
bootstrap = ["bootstrap.example:49737", "dht.example.com:49738"]
route = "public"

[gateway]
port = 17480
host = "127.0.0.1"
domain = "kepos.internal"

[metrics]
host = "127.0.0.1"
port = 0

[[peers]]
label = "nuc"
public_key = "${peerKey}"
connection = "dial"

[[peers]]
label = "phone"
public_key = "${otherPeerKey}"
connection = "accept"

[[services]]
id = "cua"
name = "Cua driver"
source = { unix_socket = "/tmp/cua.sock" }
allow = ["${peerKey}"]

[[services]]
id = "forgejo"
name = "Forgejo"
kind = "http"
source = { local_port = 3000 }
max_publisher_to_subscriber_bps = 2000000

[[services]]
id = "game"
name = "Game"
kind = "udp"
source = { local_port = 24642 }
allow = []

[[services]]
id = "remote-site"
name = "Remote site"
source = { peer = "nuc", service = "site" }
allow = ["${otherPeerKey}"]

[[bindings]]
peer = "nuc"
service = "cua"
listen = { unix_socket = "/tmp/nuc-cua.sock" }

[[bindings]]
peer = "phone"
service = "forgejo"
listen = { local_port = 0 }

[[bindings]]
peer = "nuc"
service = "game"
kind = "udp"
listen = { local_port = 0 }
`),
    {
      network: {
        bootstrap: [
          { host: "bootstrap.example", port: 49_737 },
          { host: "dht.example.com", port: 49_738 },
        ],
        route: "public",
      },
      gateway: {
        port: 17_480,
        host: "127.0.0.1",
        domain: "kepos.internal",
      },
      metrics: { host: "127.0.0.1", port: 0 },
      peers: [
        { label: "nuc", publicKey: peerKey, connection: "dial" },
        { label: "phone", publicKey: otherPeerKey, connection: "accept" },
      ],
      services: [
        {
          id: "cua",
          name: "Cua driver",
          kind: "tcp",
          source: { unixSocket: "/tmp/cua.sock" },
          allow: [peerKey],
        },
        {
          id: "forgejo",
          name: "Forgejo",
          kind: "http",
          source: { localPort: 3000 },
          allow: [],
          maxPublisherToSubscriberBps: 2_000_000,
        },
        {
          id: "game",
          name: "Game",
          kind: "udp",
          source: { localPort: 24_642 },
          allow: [],
        },
        {
          id: "remote-site",
          name: "Remote site",
          kind: "tcp",
          source: { peer: "nuc", service: "site" },
          allow: [otherPeerKey],
        },
      ],
      bindings: [
        {
          peer: "nuc",
          service: "cua",
          listen: { unixSocket: "/tmp/nuc-cua.sock" },
        },
        {
          peer: "phone",
          service: "forgejo",
          listen: { localPort: 0 },
        },
        {
          peer: "nuc",
          service: "game",
          kind: "udp",
          listen: { localPort: 0 },
        },
      ],
    },
  );
});

test("canonical config round-trips strict snake_case and defaults TCP and grants", () => {
  const config: PeerConfig = {
    network: { bootstrap: [{ host: "bootstrap.example", port: 49_737 }] },
    gateway: { port: 0 },
    peers: [{ label: "nuc", publicKey: peerKey, connection: "accept" }],
    services: [
      {
        id: "ssh",
        name: "SSH",
        kind: "tcp",
        source: { localPort: 22 },
        allow: [],
      },
    ],
    bindings: [],
  };

  const source = serializeKeposConfig(config);
  assert.match(source, /public_key = "1{64}"/);
  assert.match(source, /connection = "accept"/);
  assert.match(source, /local_port = 22/);
  assert.doesNotMatch(source, /publisher_key|service_id|display_name|subscriber/);
  assert.deepEqual(parseKeposConfig(source), config);
});

test("canonical serializer emits every source and binding variant", () => {
  const config: PeerConfig = {
    peers: [
      { label: "nuc", publicKey: peerKey, connection: "accept" },
      { label: "mac", publicKey: otherPeerKey, connection: "dial" },
    ],
    services: [
      {
        id: "unix-service",
        name: "Unix service",
        kind: "tcp",
        source: { unixSocket: "/tmp/unix-service.sock" },
        allow: [peerKey],
      },
      {
        id: "upstream-service",
        name: "Upstream service",
        kind: "http",
        source: { peer: "mac", service: "remote" },
        allow: [otherPeerKey],
        maxPublisherToSubscriberBps: 1_000,
      },
    ],
    bindings: [
      {
        peer: "nuc",
        service: "unix-service",
        listen: { unixSocket: "/tmp/bound.sock" },
      },
      {
        peer: "mac",
        service: "upstream-service",
        listen: { localPort: 0 },
      },
    ],
  };
  const source = serializeKeposConfig(config);
  assert.match(source, /unix_socket = "/);
  assert.match(source, /peer = "mac"/);
  assert.match(source, /max_publisher_to_subscriber_bps = 1000/);
  assert.match(source, /local_port = 0/);
  assert.deepEqual(parseKeposConfig(source), config);
});

test("canonical serializer carries metrics and forward UDP binding settings", () => {
  const config: PeerConfig = {
    metrics: { host: "127.0.0.1", port: 0 },
    peers: [{ label: "nuc", publicKey: peerKey, connection: "accept" }],
    services: [{
      id: "game",
      name: "Game",
      kind: "udp",
      source: { localPort: 24_642 },
      allow: [peerKey],
    }],
    bindings: [{
      peer: "nuc",
      service: "game",
      kind: "udp",
      listen: { localPort: 0 },
    }],
  };
  const source = serializeKeposConfig(config);
  assert.match(source, /\[metrics\]/);
  assert.match(source, /kind = "udp"/);
  assert.deepEqual(parseKeposConfig(source), config);
});

test("absent and empty service grants fail closed", () => {
  const source = (allow: string) => `
[[peers]]
label = "nuc"
public_key = "${peerKey}"
connection = "accept"

[[services]]
id = "ssh"
name = "SSH"
source = { local_port = 22 }
${allow}

[[bindings]]
peer = "nuc"
service = "ssh"
listen = { local_port = 0 }
`;
  assert.deepEqual(parseKeposConfig(source("")).services[0]?.allow, []);
  assert.deepEqual(parseKeposConfig(source("allow = []")).services[0]?.allow, []);
});

test("old role tables and obsolete field casing are rejected instead of translated", () => {
  for (const source of [
    `[publisher]\ndisplay_name = "old"\nsubscribers = []\nservices = []`,
    `[subscriber]\ngateway_port = 17480`,
    `[[peers]]\nlabel = "nuc"\npublicKey = "${peerKey}"\nconnection = "accept"\nservices = []\nbindings = []`,
    `peers = []\nservices = []\nbindings = []\nsubscriber = { enabled = true }`,
  ]) {
    assert.throws(() => parseKeposConfig(source), /unknown|must be an array|peer config/i);
  }
});

test("invalid references, variants, endpoints, and policy values are clear", () => {
  const base: PeerConfig = {
    peers: [{ label: "nuc", publicKey: peerKey, connection: "accept" as const }],
    services: [{ id: "ssh", name: "SSH", kind: "tcp", source: { localPort: 22 }, allow: [] }],
    bindings: [],
  };
  assert.throws(
    () => parsePeerConfig({ ...base, services: [{ ...base.services[0]!, source: { localPort: 22, unixSocket: "/tmp/x" } }] }),
    /exactly one|variant|endpoint/i,
  );
  assert.throws(
    () => parsePeerConfig({ ...base, services: [{ ...base.services[0]!, source: { peer: "missing", service: "ssh" } }] }),
    /unknown peer label/i,
  );
  assert.throws(
    () => parsePeerConfig({ ...base, bindings: [{ peer: "nuc", service: "ssh", listen: { localPort: 70000 } }] }),
    /65535/i,
  );
  assert.throws(
    () => parsePeerConfig({ ...base, services: [{ ...base.services[0]!, source: { unixSocket: "relative.sock" } }] }),
    /absolute Unix socket/i,
  );
  assert.throws(
    () => parsePeerConfig({ ...base, services: [{ ...base.services[0]!, kind: "udp", source: { unixSocket: "/tmp/udp.sock" } }] }),
    /UDP|Unix.*UDP/i,
  );
  assert.throws(
    () => parsePeerConfig({ ...base, services: [{ ...base.services[0]!, allow: [otherPeerKey] }] }),
    /unknown peer/i,
  );
});

test("Windows defaults use AppData while explicit paths remain unchanged", () => {
  assert.equal(
    defaultKeposConfigPath(
      { APPDATA: "C:\\Users\\kepos\\AppData\\Roaming" },
      "C:\\Users\\kepos",
      "win32",
    ),
    "C:\\Users\\kepos\\AppData\\Roaming\\Kepos\\config.toml",
  );
  assert.equal(
    defaultKeposStateRoot(
      { LOCALAPPDATA: "C:\\Users\\kepos\\AppData\\Local" },
      "C:\\Users\\kepos",
      "win32",
    ),
    "C:\\Users\\kepos\\AppData\\Local\\Kepos\\state",
  );
});

test("config load and atomic save use test-owned platform paths and private permissions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kepos-config-"));
  try {
    const environment =
      process.platform === "win32"
        ? { APPDATA: root }
        : { XDG_CONFIG_HOME: root };
    const configPath = defaultKeposConfigPath(environment, root, process.platform);
    assert.equal(await loadKeposConfig(undefined, environment, root, process.platform), undefined);
    const config: PeerConfig = {
      gateway: { port: 0 },
      peers: [{ label: "nuc", publicKey: peerKey, connection: "accept" }],
      services: [],
      bindings: [],
    };
    await saveKeposConfig(config, configPath);
    assert.deepEqual(await loadKeposConfig(undefined, environment, root, process.platform), config);
    assert.equal(await readFile(configPath, "utf8"), serializeKeposConfig(config));
    if (process.platform !== "win32") {
      assert.equal((await stat(configPath)).mode & 0o777, 0o600);
      assert.equal((await stat(path.dirname(configPath))).mode & 0o777, 0o700);
    }
    await assert.rejects(
      () => loadKeposConfig(path.join(root, "missing.toml")),
      /Cannot read Kepos config/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
