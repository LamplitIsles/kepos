import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  DESKTOP_BOOTSTRAP_ASSET,
  defaultDesktopPaths,
} from "../apps/desktop/src/paths.js";
import {
  ensureDesktopBootstrap,
} from "../apps/desktop/src/bootstrap.js";
import { loadDesktopOptions } from "../apps/desktop/src/options.js";
import { parseKeposConfig } from "../src/app-config.js";
import { DEFAULT_GATEWAY_PORT } from "../src/home/gateway.js";

test("desktop first launch creates one canonical config and one peer state", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kepos-desktop-bootstrap-"));
  const environment = {
    XDG_CONFIG_HOME: path.join(root, "config-home"),
    XDG_STATE_HOME: path.join(root, "state-home"),
  };
  const executablePath = path.join(
    root,
    "Kepos.app",
    "Contents",
    "MacOS",
    "Kepos",
  );
  try {
    await mkdir(path.join(root, "Kepos.app", "Contents", "Resources"), {
      recursive: true,
    });
    await writeFile(
      path.join(root, "Kepos.app", "Contents", "Resources", DESKTOP_BOOTSTRAP_ASSET),
      '[{"host":"bootstrap.example","port":49737}]\n',
    );

    const first = await loadDesktopOptions([], {
      homeDirectory: root,
      environment,
      executablePath,
      platform: "darwin",
    });
    const paths = defaultDesktopPaths({ homeDirectory: root, environment, platform: "darwin" });
    assert.equal(first.peer?.stateDir, paths.peerStateDir);
    assert.deepEqual(first.peer?.config, {
      network: { bootstrap: [{ host: "bootstrap.example", port: 49_737 }] },
      gateway: { port: DEFAULT_GATEWAY_PORT },
      peers: [],
      services: [],
      bindings: [],
    });
    assert.deepEqual(parseKeposConfig(await readFile(paths.configPath, "utf8")), first.peer?.config);
    assert.deepEqual(await readdir(paths.peerStateDir), ["peer.json"]);

    const identityBytes = await readFile(path.join(paths.peerStateDir, "peer.json"));
    const second = await loadDesktopOptions([], {
      homeDirectory: root,
      environment,
      executablePath,
      platform: "darwin",
    });
    assert.deepEqual(second, first);
    assert.deepEqual(await readFile(path.join(paths.peerStateDir, "peer.json")), identityBytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop bootstrap preserves an existing canonical config and does not read packaged defaults", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kepos-desktop-existing-"));
  const environment = {
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_STATE_HOME: path.join(root, "state"),
  };
  const paths = defaultDesktopPaths({ homeDirectory: root, environment, platform: "darwin" });
  const config = `
[gateway]
port = 18080

[[peers]]
label = "nuc"
public_key = "${"11".repeat(32)}"
connection = "accept"

[[services]]
id = "ssh"
name = "SSH"
source = { local_port = 22 }
allow = ["${"11".repeat(32)}"]

[[bindings]]
peer = "nuc"
service = "remote"
listen = { local_port = 0 }
`;
  try {
    await mkdir(path.dirname(paths.configPath), { recursive: true });
    await writeFile(paths.configPath, config);
    const result = await ensureDesktopBootstrap({
      homeDirectory: root,
      environment,
      platform: "darwin",
      readBootstrapAsset: async () => {
        throw new Error("packaged asset should not be read");
      },
    });
    assert.deepEqual(result.config, parseKeposConfig(config));
    assert.deepEqual(result.config, parseKeposConfig(await readFile(paths.configPath, "utf8")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop Windows bootstrap selects the canonical AppData paths", async () => {
  const saved: string[] = [];
  const ensured: string[] = [];
  const config = { peers: [], services: [], bindings: [] } as const;
  const result = await ensureDesktopBootstrap({
    homeDirectory: "C:\\Users\\kepos",
    environment: {
      APPDATA: "C:\\Users\\kepos\\AppData\\Roaming",
      LOCALAPPDATA: "C:\\Users\\kepos\\AppData\\Local",
    },
    platform: "win32",
    readBootstrapAsset: async (assetPath) => {
      assert.equal(assetPath, "C:\\Program Files\\Kepos\\kepos-bootstrap.json");
      return [{ host: "bootstrap.example", port: 49_737 }];
    },
    saveConfig: async (_value, configPath) => {
      if (configPath) saved.push(configPath);
    },
    ensurePeer: async ({ stateDir }) => {
      ensured.push(stateDir);
      return { created: ensured.length === 1, publicKey: "aa".repeat(32) };
    },
    executablePath: "C:\\Program Files\\Kepos\\Kepos.exe",
  });
  assert.deepEqual(result.config, {
    network: { bootstrap: [{ host: "bootstrap.example", port: 49_737 }] },
    gateway: { port: DEFAULT_GATEWAY_PORT },
    ...config,
  });
  assert.deepEqual(saved, ["C:\\Users\\kepos\\AppData\\Roaming\\Kepos\\config.toml"]);
  assert.deepEqual(ensured, ["C:\\Users\\kepos\\AppData\\Local\\Kepos\\state\\peer"]);
});

test("explicit desktop config is required to be canonical and missing files do not create state", async () => {
  let saved = false;
  let ensured = false;
  await assert.rejects(
    loadDesktopOptions(["--config", "/tmp/does-not-exist/kepos.toml"], {
      homeDirectory: "/tmp/desktop-test-home",
      platform: "darwin",
      loadConfig: async () => undefined,
      saveConfig: async () => {
        saved = true;
      },
      ensurePeer: async () => {
        ensured = true;
        return { created: true, publicKey: "11".repeat(32) };
      },
    }),
    /does not exist/,
  );
  assert.equal(saved, false);
  assert.equal(ensured, false);
  await assert.rejects(
    loadDesktopOptions(["--publisher-state", "legacy"], {
      homeDirectory: "/tmp/desktop-test-home",
      platform: "darwin",
      loadConfig: async () => undefined,
    }),
    /role flags were removed/,
  );
});
