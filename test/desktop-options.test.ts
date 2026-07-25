import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { parseDesktopOptions } from "../apps/desktop/src/options.js";

test("desktop derives enabled roles from shared config and fixed state paths", () => {
  assert.deepEqual(
    parseDesktopOptions([], {
      homeDirectory: "/Users/neil",
      environment: { XDG_STATE_HOME: "" },
      config: {
        network: { bootstrap: [{ host: "bootstrap.example", port: 49_737 }] },
        publisher: {
          enabled: false,
          displayName: "Neil",
          allow: [],
          services: [],
        },
        subscriber: {
          enabled: true,
          gatewayPort: 17_480,
          gatewayHost: "0.0.0.0",
          gatewayDomain: "kepos.internal",
          route: "public",
          services: [{ id: "ssh", localPort: 2_222 }],
        },
      },
    }),
    {
      subscriber: {
        stateDir: "/Users/neil/.local/state/kepos-neo/subscriber",
        gatewayPort: 17_480,
        gatewayHost: "0.0.0.0",
        gatewayDomain: "kepos.internal",
        route: "public",
        bootstrap: [{ host: "bootstrap.example", port: 49_737 }],
        services: [{ id: "ssh", localPort: 2_222 }],
      },
    },
  );
});

test("desktop loads the shared config when no role flags are given", async () => {
  const module = (await import(
    "../apps/desktop/src/options.js"
  )) as Record<string, unknown>;
  assert.equal(typeof module.loadDesktopOptions, "function");
  const loadDesktopOptions = module.loadDesktopOptions as (
    arguments_: readonly string[],
    context: Record<string, unknown>,
  ) => Promise<unknown>;
  const loadedPaths: Array<string | undefined> = [];
  const loadedHomes: Array<string | undefined> = [];

  const options = await loadDesktopOptions([], {
    homeDirectory: "/Users/neil",
    environment: {},
    loadConfig: async (configPath?: string, _environment?: unknown, home?: string) => {
      loadedPaths.push(configPath);
      loadedHomes.push(home);
      return {
        subscriber: { enabled: true, services: [] },
      };
    },
  });

  assert.deepEqual(loadedPaths, [undefined]);
  assert.deepEqual(loadedHomes, ["/Users/neil"]);
  assert.deepEqual(options, {
    subscriber: {
      stateDir: "/Users/neil/.local/state/kepos-neo/subscriber",
      gatewayPort: 17_480,
      services: [],
    },
  });
});

test("desktop launch options accept subscriber-only mode", () => {
  assert.deepEqual(
    parseDesktopOptions([
      "--subscriber-state",
      "./subscriber",
      "--subscriber-service",
      "ssh:2222",
      "--subscriber-service",
      "postgres:15432",
    ]),
    {
      subscriber: {
        stateDir: path.resolve("./subscriber"),
        gatewayPort: 17_480,
        services: [
          { id: "ssh", localPort: 2222 },
          { id: "postgres", localPort: 15_432 },
        ],
      },
    },
  );
});

test("desktop launch options accept publisher-only mode", () => {
  assert.deepEqual(
    parseDesktopOptions(["--publisher-state", "./publisher"]),
    {
      publisher: { stateDir: path.resolve("./publisher") },
    },
  );
});

test("desktop launch options accept simultaneous publisher and subscriber roles", () => {
  assert.deepEqual(
    parseDesktopOptions([
      "--publisher-state",
      "./publisher",
      "--subscriber-state",
      "./subscriber",
      "--subscriber-service",
      "ssh:2222",
    ]),
    {
      publisher: { stateDir: path.resolve("./publisher") },
      subscriber: {
        stateDir: path.resolve("./subscriber"),
        gatewayPort: 17_480,
        services: [{ id: "ssh", localPort: 2222 }],
      },
    },
  );
});

test("desktop launch options require at least one role", () => {
  assert.throws(() => parseDesktopOptions([]), /at least one role/);
});

test("desktop launch options reject services without subscriber state", () => {
  assert.throws(
    () =>
      parseDesktopOptions([
        "--publisher-state",
        "./publisher",
        "--subscriber-service",
        "ssh:2222",
      ]),
    /subscriber service requires --subscriber-state/,
  );
});

test("desktop launch options reject duplicate role state and service ids", () => {
  assert.throws(
    () =>
      parseDesktopOptions([
        "--publisher-state",
        "first",
        "--publisher-state",
        "second",
      ]),
    /--publisher-state may be set only once/,
  );
  assert.throws(
    () =>
      parseDesktopOptions([
        "--subscriber-state",
        "subscriber",
        "--subscriber-service",
        "ssh:2222",
        "--subscriber-service",
        "ssh:2223",
      ]),
    /unique ids/,
  );
});

test("desktop launch options reject legacy, unknown, and invalid options", () => {
  assert.throws(
    () => parseDesktopOptions(["--state", "state"]),
    /unknown option/,
  );
  assert.throws(
    () => parseDesktopOptions(["--subscriber-state", "state", "--unknown", "x"]),
    /unknown option/,
  );
  assert.throws(
    () =>
      parseDesktopOptions([
        "--subscriber-state",
        "state",
        "--subscriber-service",
        "ssh:0",
      ]),
    /port/,
  );
});
