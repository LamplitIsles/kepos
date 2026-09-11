import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyDesktopConfig,
  persistDesktopPublisherSubscribers,
} from "../apps/desktop/src/config.js";
import { defaultDesktopPaths } from "../apps/desktop/src/paths.js";
import type { PeerConfig } from "../src/config.js";

test("desktop config saves the canonical document before applying it in memory", async () => {
  const events: string[] = [];
  const config: PeerConfig = {
    gateway: { port: 17_480 },
    peers: [{ label: "nuc", publicKey: "11".repeat(32), connection: "accept" }],
    services: [{ id: "ssh", name: "SSH", kind: "tcp", source: { localPort: 22 }, allow: [] }],
    bindings: [],
  };
  const paths = defaultDesktopPaths({
    homeDirectory: "/Users/neil",
    environment: { XDG_STATE_HOME: "/Users/neil/.local/state" },
    platform: "linux",
  });
  const options = await applyDesktopConfig(config, {
    homeDirectory: "/Users/neil",
    environment: { XDG_STATE_HOME: "/Users/neil/.local/state" },
    platform: "linux",
    configPath: "/Users/neil/.config/kepos/config.toml",
    saveConfig: async (saved, configPath) => {
      assert.deepEqual(saved, config);
      assert.equal(configPath, "/Users/neil/.config/kepos/config.toml");
      events.push("save");
    },
    reconfigure: async (next) => {
      events.push("reconfigure");
      assert.deepEqual(next, {
        peer: {
          stateDir: paths.peerStateDir,
          configPath: "/Users/neil/.config/kepos/config.toml",
          config,
        },
      });
    },
  });
  assert.deepEqual(events, ["save", "reconfigure"]);
  assert.deepEqual(options.peer, {
    stateDir: paths.peerStateDir,
    configPath: "/Users/neil/.config/kepos/config.toml",
    config,
  });
});

test("removed desktop subscriber policy persistence fails instead of rewriting legacy TOML", async () => {
  await assert.rejects(
    persistDesktopPublisherSubscribers(
      "/tmp/desktop-test-config.toml",
      [{ label: "phone", publicKey: "11".repeat(32) }],
    ),
    /removed|peer pair|allowlists/i,
  );
});
