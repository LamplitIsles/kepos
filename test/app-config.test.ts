import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  defaultKeposConfigPath,
  loadKeposConfig,
  parseKeposConfig,
} from "../src/app-config.js";
import { defaultKeposStateRoot } from "../src/platform/paths.js";

test("shared config parses network bootstrap endpoints", () => {
  assert.deepEqual(
    parseKeposConfig(`
[network]
bootstrap = ["bootstrap.example:49737", "dht.example.com:49738"]
`),
    {
      network: {
        bootstrap: [
          { host: "bootstrap.example", port: 49_737 },
          { host: "dht.example.com", port: 49_738 },
        ],
      },
    },
  );
});

test("shared config parses publisher and subscriber policy", () => {
  const subscriberKey = "11".repeat(32);
  assert.deepEqual(
    parseKeposConfig(`
[network]
bootstrap = []

[publisher]
display_name = "kosmos"
allow = ["${subscriberKey}"]

[[publisher.services]]
id = "navidrome"
name = "Navidrome"
target_port = 4533
allow = ["${subscriberKey}"]

[subscriber]
gateway_port = 17480
gateway_host = "0.0.0.0"
gateway_domain = "kepos.internal"
route = "auto"

[[subscriber.services]]
id = "ssh"
local_port = 2222
`),
    {
      network: {},
      publisher: {
        displayName: "kosmos",
        allow: [subscriberKey],
        services: [
          {
            id: "navidrome",
            name: "Navidrome",
            targetPort: 4533,
            allow: [subscriberKey],
          },
        ],
      },
      subscriber: {
        gatewayPort: 17_480,
        gatewayHost: "0.0.0.0",
        gatewayDomain: "kepos.internal",
        route: "auto",
        services: [{ id: "ssh", localPort: 2_222 }],
      },
    },
  );
});

test("shared config keeps desktop role enable flags beside each policy", () => {
  assert.deepEqual(
    parseKeposConfig(`
[publisher]
enabled = false
display_name = "kosmos"
allow = []
services = []

[subscriber]
enabled = true
gateway_port = 17480
services = []
`),
    {
      publisher: {
        enabled: false,
        displayName: "kosmos",
        allow: [],
        services: [],
      },
      subscriber: {
        enabled: true,
        gatewayPort: 17_480,
        services: [],
      },
    },
  );
});

test("shared config keeps deny-all and Home-only publisher policy explicit", () => {
  assert.deepEqual(
    parseKeposConfig(`
[publisher]
display_name = "kosmos"
allow = []
services = []
`),
    {
      publisher: {
        displayName: "kosmos",
        allow: [],
        services: [],
      },
    },
  );
});

test("shared config rejects incomplete or invalid role policy", () => {
  assert.throws(
    () => parseKeposConfig('[publisher]\ndisplay_name = "kosmos"'),
    /publisher\.allow must be an array/,
  );
  assert.throws(
    () =>
      parseKeposConfig(
        '[publisher]\ndisplay_name = "kosmos"\nallow = []\nservices = []\nextra = true',
      ),
    /unknown field: publisher\.extra/,
  );
  assert.throws(
    () => parseKeposConfig('[subscriber]\ngateway_port = 70000'),
    /subscriber\.gateway_port.*65535/,
  );
  assert.throws(
    () => parseKeposConfig('[subscriber]\ngateway_host = "bad host"'),
    /subscriber\.gateway_host/,
  );
  assert.throws(
    () => parseKeposConfig('[subscriber]\ngateway_domain = ".internal"'),
    /subscriber\.gateway_domain/,
  );
});

test("shared config rejects unknown fields and malformed endpoints", () => {
  assert.throws(
    () => parseKeposConfig("[network]\nbootstraps = []"),
    /unknown field: network\.bootstraps/,
  );
  assert.throws(
    () => parseKeposConfig('[network]\nbootstrap = ["bootstrap.example"]'),
    /network\.bootstrap.*host:port/,
  );
});

test("Windows defaults use AppData while explicit paths remain unchanged", () => {
  assert.equal(
    defaultKeposConfigPath(
      { APPDATA: "C:\\Users\\kepos\\AppData\\Roaming" },
      "C:\\Users\\kepos",
      "win32",
    ),
    "C:\\Users\\kepos\\AppData\\Roaming\\kepos\\config.toml",
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

test("shared config follows XDG and distinguishes default from explicit files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kepos-config-"));
  const configPath = path.join(root, "kepos", "config.toml");
  assert.equal(defaultKeposConfigPath({ XDG_CONFIG_HOME: root }), configPath);
  assert.equal(
    await loadKeposConfig(undefined, { XDG_CONFIG_HOME: root }),
    undefined,
  );
  await assert.rejects(
    () => loadKeposConfig(path.join(root, "missing.toml")),
    /Cannot read Kepos config/,
  );

  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(
    configPath,
    '[network]\nbootstrap = ["bootstrap.example:49737"]\n',
  );
  assert.deepEqual(await loadKeposConfig(undefined, { XDG_CONFIG_HOME: root }), {
    network: { bootstrap: [{ host: "bootstrap.example", port: 49_737 }] },
  });
});

test("shared config atomically persists the validated desktop shape", async () => {
  const module = (await import("../src/app-config.js")) as Record<
    string,
    unknown
  >;
  assert.equal(typeof module.serializeKeposConfig, "function");
  assert.equal(typeof module.saveKeposConfig, "function");
  const serializeKeposConfig = module.serializeKeposConfig as (
    config: unknown,
  ) => string;
  const saveKeposConfig = module.saveKeposConfig as (
    config: unknown,
    configPath: string,
  ) => Promise<void>;
  const config = {
    network: { bootstrap: [{ host: "bootstrap.example", port: 49_737 }] },
    publisher: {
      enabled: false,
      displayName: "Neil",
      allow: ["11".repeat(32)],
      services: [
        {
          id: "dagger",
          name: "Dagger",
          targetPort: 18_080,
          allow: ["11".repeat(32)],
        },
      ],
    },
    subscriber: {
      enabled: true,
      gatewayPort: 17_480,
      gatewayHost: "0.0.0.0",
      gatewayDomain: "kepos.internal",
      route: "auto",
      services: [{ id: "ssh", localPort: 2_222 }],
    },
  };

  const source = serializeKeposConfig(config);
  assert.deepEqual(parseKeposConfig(source), config);
  const root = await mkdtemp(path.join(os.tmpdir(), "kepos-config-save-"));
  const configPath = path.join(root, "kepos", "config.toml");
  await saveKeposConfig(config, configPath);
  assert.equal(await readFile(configPath, "utf8"), source);
  assert.equal((await stat(configPath)).mode & 0o777, 0o600);
});
