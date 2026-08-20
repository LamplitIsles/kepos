import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { DESKTOP_BOOTSTRAP_ASSET } from "../apps/desktop/src/paths.js";

import { parseKeposConfig, type KeposConfig } from "../src/app-config.js";
import { DEFAULT_GATEWAY_PORT } from "../src/home/gateway.js";
import { ensureDesktopBootstrap } from "../apps/desktop/src/bootstrap.js";
import { loadDesktopOptions } from "../apps/desktop/src/options.js";

const subscriberKey = "11".repeat(32);

test("desktop bootstrap resolves macOS default config and state paths", async () => {
  const saved: string[] = [];
  const state: string[] = [];
  const result = await ensureDesktopBootstrap({
    homeDirectory: "/Users/kepos",
    environment: {
      XDG_CONFIG_HOME: "/Users/kepos/.config",
      XDG_STATE_HOME: "/Users/kepos/.local/state",
    },
    platform: "darwin",
    loadConfig: async () => undefined,
    saveConfig: async (_config, configPath) => {
      assert.ok(configPath);
      saved.push(configPath);
    },
    setupSubscriber: async ({ stateDir }) => {
      state.push(stateDir);
      return { created: true, configured: false, publicKey: subscriberKey };
    },
  });

  assert.equal(result.configPath, "/Users/kepos/.config/kepos/config.toml");
  assert.deepEqual(saved, ["/Users/kepos/.config/kepos/config.toml"]);
  assert.deepEqual(state, ["/Users/kepos/.local/state/kepos-neo/subscriber"]);
  assert.deepEqual(result.config, {
    subscriber: { enabled: true, gatewayPort: DEFAULT_GATEWAY_PORT, services: [] },
  });
});

test("desktop bootstrap resolves Windows default config and state paths", async () => {
  const saved: string[] = [];
  const state: string[] = [];
  let loadedPlatform: NodeJS.Platform | undefined;
  await ensureDesktopBootstrap({
    homeDirectory: "C:\\Users\\kepos",
    environment: {
      APPDATA: "C:\\Users\\kepos\\AppData\\Roaming",
      LOCALAPPDATA: "C:\\Users\\kepos\\AppData\\Local",
    },
    platform: "win32",
    loadConfig: async (
      _configPath,
      _environment,
      _homeDirectory,
      platform,
    ) => {
      loadedPlatform = platform;
      return undefined;
    },
    saveConfig: async (_config, configPath) => {
      assert.ok(configPath);
      saved.push(configPath);
    },
    setupSubscriber: async ({ stateDir }) => {
      state.push(stateDir);
      return { created: true, configured: false, publicKey: subscriberKey };
    },
  });

  assert.equal(loadedPlatform, "win32");
  assert.deepEqual(saved, [
    "C:\\Users\\kepos\\AppData\\Roaming\\Kepos\\config.toml",
  ]);
  assert.deepEqual(state, [
    "C:\\Users\\kepos\\AppData\\Local\\Kepos\\state\\subscriber",
  ]);
});

test("desktop Windows first launch and relaunch preserve injected filesystem state", async () => {
  const files = new Map<string, KeposConfig>();
  const savedPaths: string[] = [];
  const setupPaths: string[] = [];
  const context = {
    homeDirectory: "C:\\Users\\kepos",
    environment: {
      APPDATA: "C:\\Users\\kepos\\AppData\\Roaming",
      LOCALAPPDATA: "C:\\Users\\kepos\\AppData\\Local",
    },
    platform: "win32" as const,
    loadConfig: async (configPath?: string) =>
      files.get(
        configPath ??
          "C:\\Users\\kepos\\AppData\\Roaming\\Kepos\\config.toml",
      ),
    saveConfig: async (config: KeposConfig, configPath?: string) => {
      assert.ok(configPath);
      savedPaths.push(configPath);
      files.set(configPath, config);
    },
    setupSubscriber: async ({ stateDir }: { stateDir: string }) => {
      setupPaths.push(stateDir);
      return {
        created: setupPaths.length === 1,
        configured: false,
        publicKey: subscriberKey,
      };
    },
  };

  const first = await ensureDesktopBootstrap(context);
  const second = await ensureDesktopBootstrap(context);

  assert.deepEqual(savedPaths, [
    "C:\\Users\\kepos\\AppData\\Roaming\\Kepos\\config.toml",
  ]);
  assert.deepEqual(setupPaths, [
    "C:\\Users\\kepos\\AppData\\Local\\Kepos\\state\\subscriber",
    "C:\\Users\\kepos\\AppData\\Local\\Kepos\\state\\subscriber",
  ]);
  assert.deepEqual(second.config, first.config);
  assert.equal(second.configPath, first.configPath);
  assert.equal(second.subscriber?.publicKey, first.subscriber?.publicKey);
});

test("desktop first launch creates and repeats preserve config and subscriber identity", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kepos-desktop-bootstrap-"));
  const environment = {
    XDG_CONFIG_HOME: path.join(root, "config-home"),
    XDG_STATE_HOME: path.join(root, "state-home"),
  };
  try {
    const executablePath = path.join(
      root,
      "Kepos.app",
      "Contents",
      "MacOS",
      "Kepos",
    );
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
    const configPath = path.join(
      environment.XDG_CONFIG_HOME,
      "kepos",
      "config.toml",
    );
    const identityPath = path.join(
      environment.XDG_STATE_HOME,
      "kepos-neo",
      "subscriber",
      "client.identity.json",
    );
    const configBytes = await readFile(configPath);
    const identityBytes = await readFile(identityPath);

    assert.deepEqual(first, {
      bootstrap: [{ host: "bootstrap.example", port: 49_737 }],
      subscriber: {
        stateDir: path.join(
          environment.XDG_STATE_HOME,
          "kepos-neo",
          "subscriber",
        ),
        gatewayPort: DEFAULT_GATEWAY_PORT,
        services: [],
        subscriberSetup: {
          configured: false,
          publicKey: JSON.parse(await readFile(identityPath, "utf8")).publicKey,
        },
      },
    });
    assert.deepEqual(parseKeposConfig(configBytes.toString()), {
      network: {
        bootstrap: [{ host: "bootstrap.example", port: 49_737 }],
      },
      subscriber: { enabled: true, gatewayPort: DEFAULT_GATEWAY_PORT, services: [] },
    });

    const second = await loadDesktopOptions([], {
      homeDirectory: root,
      environment,
      executablePath,
      platform: "darwin",
    });
    assert.deepEqual(second, first);
    assert.deepEqual(await readFile(configPath), configBytes);
    assert.deepEqual(await readFile(identityPath), identityBytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop bootstrap preserves an existing default config", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kepos-desktop-existing-"));
  const configPath = path.join(root, "config", "kepos", "config.toml");
  const config =
    '[network]\nbootstrap = ["bootstrap.example:49737"]\n\n[subscriber]\nenabled = true\ngateway_port = 18080\nservices = []\n';
  try {
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, config);
    const executablePath = path.join(
      root,
      "Kepos.app",
      "Contents",
      "MacOS",
      "Kepos",
    );
    await mkdir(path.join(root, "Kepos.app", "Contents", "Resources"), {
      recursive: true,
    });
    await writeFile(
      path.join(root, "Kepos.app", "Contents", "Resources", DESKTOP_BOOTSTRAP_ASSET),
      '[{"host":"packaged.example","port":49739}]\n',
    );
    const options = await loadDesktopOptions([], {
      homeDirectory: root,
      environment: {
        XDG_CONFIG_HOME: path.join(root, "config"),
        XDG_STATE_HOME: path.join(root, "state"),
      },
      executablePath,
      platform: "darwin",
    });

    const identityPath = path.join(
      root,
      "state",
      "kepos-neo",
      "subscriber",
      "client.identity.json",
    );
    const identityBytes = await readFile(identityPath);
    assert.equal(await readFile(configPath, "utf8"), config);
    assert.deepEqual(options.subscriber, {
      stateDir: path.join(root, "state", "kepos-neo", "subscriber"),
      gatewayPort: 18_080,
      services: [],
      subscriberSetup: {
        configured: false,
        publicKey: JSON.parse(
          await readFile(
            path.join(
              root,
              "state",
              "kepos-neo",
              "subscriber",
              "client.identity.json",
            ),
            "utf8",
          ),
        ).publicKey,
      },
    });

    await loadDesktopOptions([], {
      homeDirectory: root,
      environment: {
        XDG_CONFIG_HOME: path.join(root, "config"),
        XDG_STATE_HOME: path.join(root, "state"),
      },
      executablePath,
      platform: "darwin",
    });
    assert.equal(await readFile(configPath, "utf8"), config);
    assert.deepEqual(await readFile(identityPath), identityBytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("explicit desktop config does not invoke default bootstrap", async () => {
  let saved = false;
  let setup = false;
  await assert.rejects(
    loadDesktopOptions(["--config", "/tmp/explicit-kepos.toml"], {
      homeDirectory: "/Users/kepos",
      platform: "darwin",
      loadConfig: async () => undefined,
      saveConfig: async () => {
        saved = true;
      },
      setupSubscriber: async () => {
        setup = true;
        return { created: true, configured: false, publicKey: subscriberKey };
      },
    }),
    /at least one role/,
  );
  assert.equal(saved, false);
  assert.equal(setup, false);
});
