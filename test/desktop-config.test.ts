import assert from "node:assert/strict";
import { test } from "node:test";

test("desktop config writes desired state before applying it in memory", async () => {
  const module = (await import(
    "../apps/desktop/src/config.js"
  ).catch(() => ({}))) as Record<string, unknown>;
  assert.equal(typeof module.applyDesktopConfig, "function");
  const applyDesktopConfig = module.applyDesktopConfig as (
    config: unknown,
    context: Record<string, unknown>,
  ) => Promise<unknown>;
  const events: string[] = [];
  const config = {
    subscriber: { enabled: true, services: [] },
  };

  const options = await applyDesktopConfig(config, {
    homeDirectory: "/Users/neil",
    configPath: "/Users/neil/.config/kepos/config.toml",
    saveConfig: async (saved: unknown, configPath: string) => {
      assert.equal(saved, config);
      assert.equal(configPath, "/Users/neil/.config/kepos/config.toml");
      events.push("save");
    },
    reconfigure: async (next: unknown) => {
      events.push("reconfigure");
      assert.deepEqual(next, {
        subscriber: {
          stateDir: "/Users/neil/.local/state/kepos-neo/subscriber",
          gatewayPort: 17_480,
          services: [],
        },
      });
    },
  });

  assert.deepEqual(events, ["save", "reconfigure"]);
  assert.deepEqual(options, {
    subscriber: {
      stateDir: "/Users/neil/.local/state/kepos-neo/subscriber",
      gatewayPort: 17_480,
      services: [],
    },
  });
});

test("desktop pairing appends allowlist through the fresh TOML config", async () => {
  const { persistDesktopPublisherAllowlist } = await import(
    "../apps/desktop/src/config.js"
  );
  const configPath = "/Users/neil/.config/kepos/config.toml";
  const original = {
    network: { bootstrap: [{ host: "bootstrap.example", port: 49_737 }] },
    publisher: {
      enabled: true,
      displayName: "Neil",
      allow: ["11".repeat(32)],
      services: [],
    },
  };
  let saved: unknown;

  await persistDesktopPublisherAllowlist(
    configPath,
    ["11".repeat(32), "22".repeat(32)],
    {
      loadConfig: async (loadedPath) => {
        assert.equal(loadedPath, configPath);
        return original;
      },
      saveConfig: async (config, savedPath) => {
        assert.equal(savedPath, configPath);
        saved = config;
      },
    },
  );

  assert.deepEqual(saved, {
    ...original,
    publisher: {
      ...original.publisher,
      allow: ["11".repeat(32), "22".repeat(32)],
    },
  });
});
