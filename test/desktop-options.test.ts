import assert from "node:assert/strict";
import { test } from "node:test";

import { parseDesktopOptions, loadDesktopOptions } from "../apps/desktop/src/options.js";
import { defaultDesktopPaths } from "../apps/desktop/src/paths.js";
import type { PeerConfig } from "../src/config.js";

const peerKey = "11".repeat(32);
const config: PeerConfig = {
  network: { bootstrap: [{ host: "bootstrap.example", port: 49_737 }] },
  gateway: { port: 17_480, host: "127.0.0.1", domain: "kepos.internal" },
  peers: [{ label: "nuc", publicKey: peerKey, connection: "dial" }],
  services: [{ id: "ssh", name: "SSH", kind: "tcp", source: { localPort: 22 }, allow: [peerKey] }],
  bindings: [{ peer: "nuc", service: "remote", listen: { localPort: 0 } }],
};

test("desktop derives one peer runtime from the canonical config", () => {
  const options = parseDesktopOptions([], {
    homeDirectory: "/Users/neil",
    environment: { XDG_STATE_HOME: "" },
    platform: "linux",
    config,
    configPath: "/Users/neil/.config/kepos/config.toml",
  });
  assert.deepEqual(options, {
    bootstrap: config.network?.bootstrap,
    peer: {
      stateDir: "/Users/neil/.local/state/kepos-neo/peer",
      configPath: "/Users/neil/.config/kepos/config.toml",
      config,
    },
  });
});

test("desktop loads canonical config and ensures the peer state directory", async () => {
  const loadedPaths: Array<string | undefined> = [];
  const ensured: string[] = [];
  const options = await loadDesktopOptions([], {
    homeDirectory: "/Users/neil",
    environment: { XDG_STATE_HOME: "/tmp/desktop-options-state" },
    platform: "linux",
    loadConfig: async (configPath) => {
      loadedPaths.push(configPath);
      return config;
    },
    ensurePeer: async ({ stateDir }) => {
      ensured.push(stateDir);
      return { created: true, publicKey: "aa".repeat(32) };
    },
  });
  assert.deepEqual(loadedPaths, [undefined]);
  assert.deepEqual(ensured, ["/tmp/desktop-options-state/kepos-neo/peer"]);
  assert.deepEqual(options.peer?.config, config);
  assert.equal(options.peer?.configPath, "/Users/neil/.config/kepos/config.toml");
});

test("explicit desktop config preserves its path and remains canonical", async () => {
  const configPath = "/tmp/desktop-options-config.toml";
  const options = await loadDesktopOptions(["--config", configPath], {
    homeDirectory: "/Users/neil",
    environment: { XDG_STATE_HOME: "/tmp/desktop-options-state" },
    platform: "darwin",
    loadConfig: async (loadedPath) => {
      assert.equal(loadedPath, configPath);
      return config;
    },
    ensurePeer: async ({ stateDir }) => {
      assert.equal(
        stateDir,
        defaultDesktopPaths({
          homeDirectory: "/Users/neil",
          environment: { XDG_STATE_HOME: "/tmp/desktop-options-state" },
          platform: "darwin",
        }).peerStateDir,
      );
      return { created: false, publicKey: "aa".repeat(32) };
    },
  });
  assert.equal(options.peer?.configPath, configPath);
});

test("desktop rejects old role flags and malformed canonical input", () => {
  for (const arguments_ of [
    ["--publisher-state", "publisher"],
    ["--subscriber-state", "subscriber"],
    ["--subscriber-service", "ssh:2222"],
    ["--state", "state"],
  ]) {
    assert.throws(
      () => parseDesktopOptions(arguments_, { homeDirectory: "/tmp", config }),
      /role flags were removed/,
    );
  }
  assert.throws(
    () => parseDesktopOptions([], { homeDirectory: "/tmp" }),
    /canonical config/,
  );
  assert.throws(
    () => parseDesktopOptions([], { homeDirectory: "/tmp", config: { ...config, peers: [] } }),
    /unknown peer|allow|binding/i,
  );
});
