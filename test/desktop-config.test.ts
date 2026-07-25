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
