import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  createDefaultCliDependencies,
  runCli,
  type CliDependencies,
} from "../src/cli/main.js";
import { waitForSignal } from "../src/cli/signals.js";
import type { Observation } from "../src/mux/observability.js";
import { setupPublisher } from "../src/state/publisher.js";

interface Calls {
  setupPublisher: unknown[];
  setupSubscriber: unknown[];
  setSubscriberPublisher: unknown[];
  setPublisherAllowlist: unknown[];
  setPublisherServices: unknown[];
  startDevice: unknown[];
  startPublisher: unknown[];
  startSubscriber: unknown[];
  publisherLocks: string[];
  subscriberLocks: string[];
  stopped: string[];
  configPaths: Array<string | undefined>;
  runtime: string[];
}

function fakeCli(): {
  calls: Calls;
  dependencies: CliDependencies;
  stderr: string[];
  stdout: string[];
} {
  const calls: Calls = {
    setupPublisher: [],
    setupSubscriber: [],
    setSubscriberPublisher: [],
    setPublisherAllowlist: [],
    setPublisherServices: [],
    startDevice: [],
    startPublisher: [],
    startSubscriber: [],
    publisherLocks: [],
    subscriberLocks: [],
    stopped: [],
    configPaths: [],
    runtime: [],
  };
  const stdout: string[] = [];
  const stderr: string[] = [];
  const dependencies: CliDependencies & {
    acquirePublisherRuntimeLock(stateDir: string): Promise<{ release(): Promise<void> }>;
  } = {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
    loadConfig: async (configPath) => {
      calls.configPaths.push(configPath);
      return undefined;
    },
    setupPublisher: async (options) => {
      calls.setupPublisher.push(options);
      return { created: true, publisherKey: "11".repeat(32) };
    },
    setupSubscriber: async (options) => {
      calls.setupSubscriber.push(options);
      return {
        created: true,
        configured: false,
        publicKey: "22".repeat(32),
      };
    },
    setSubscriberPublisher: async (options) => {
      calls.setSubscriberPublisher.push(options);
      return path.join(options.stateDir, "publisher.contact.json");
    },
    setPublisherAllowlist: async (options) => {
      calls.setPublisherAllowlist.push(options);
    },
    setPublisherServices: async (options) => {
      calls.setPublisherServices.push(options);
    },
    getPublisherPublicKey: async () => "11".repeat(32),
    startPublisher: async (options) => {
      calls.startPublisher.push(options);
      options.observe?.({
        component: "kepos",
        timestamp: new Date(0).toISOString(),
        elapsedMs: 0,
        event: "outer.connected",
        role: "publisher",
        outerId: "outer-pub",
        attempt: 2,
      });
      return {
        publisherKey: "11".repeat(32),
        home: { url: "http://127.0.0.1:3000" },
        status: () => ({
          role: "publisher" as const,
          state: "running" as const,
          publisherKey: "11".repeat(32),
          homeUrl: "http://127.0.0.1:3000",
          acceptedConnections: 1,
          activeSubscribers: 1,
          activeSubscriberKeys: ["22".repeat(32)],
          pairing: { phase: "idle" as const },
        }),
        stop: async () => {
          calls.stopped.push("publisher");
        },
      };
    },
    startSubscriber: async (options) => {
      calls.startSubscriber.push(options);
      options.observe?.({
        component: "kepos",
        timestamp: new Date(0).toISOString(),
        elapsedMs: 0,
        event: "outer.connected",
        role: "subscriber",
        route: options.route,
        outerId: "outer-sub",
      } satisfies Observation);
      return {
        publisherKey: "11".repeat(32),
        home: { url: "http://127.0.0.1:4000" },
        services: options.services.map(({ id, localPort }) => ({
          id,
          port: localPort,
        })),
        status: () => ({
          role: "subscriber" as const,
          state: "running" as const,
          connection: "connected" as const,
          connectionGeneration: 1,
          publisherKey: "11".repeat(32),
          publisherLabel: "publisher",
          subscriberKey: "22".repeat(32),
          homeUrl: "http://127.0.0.1:4000",
          services: options.services.map(({ id, localPort }) => ({
            id,
            port: localPort,
          })),
        }),
        stop: async () => {
          calls.stopped.push("subscriber");
        },
      };
    },
    startDevice: async (options) => {
      calls.startDevice.push(options);
      calls.runtime.push("device.start");
      const publisher = options.publisher
        ? await dependencies.startPublisher(options.publisher)
        : undefined;
      const subscriber = options.subscriber
        ? await dependencies.startSubscriber(options.subscriber)
        : undefined;
      return {
        publisher,
        subscriber,
        stop: async () => {
          calls.runtime.push("device.stop");
          calls.stopped.push("device");
        },
      };
    },
    acquireSubscriberRuntimeLock: async (stateDir) => {
      calls.subscriberLocks.push(`acquire:${stateDir}`);
      calls.runtime.push(`subscriber.acquire:${stateDir}`);
      return {
        release: async () => {
          calls.subscriberLocks.push(`release:${stateDir}`);
          calls.runtime.push(`subscriber.release:${stateDir}`);
        },
      };
    },
    acquirePublisherRuntimeLock: async (stateDir) => {
      calls.publisherLocks.push(`acquire:${stateDir}`);
      calls.runtime.push(`publisher.acquire:${stateDir}`);
      return {
        release: async () => {
          calls.publisherLocks.push(`release:${stateDir}`);
          calls.runtime.push(`publisher.release:${stateDir}`);
        },
      };
    },
    waitForSignal: async (stop) => {
      await stop();
    },
  };
  return { calls, dependencies, stderr, stdout };
}

test("device run selects explicit roles and owns their shared lifecycle", async () => {
  const cli = fakeCli();
  cli.dependencies.loadConfig = async (configPath) => {
    cli.calls.configPaths.push(configPath);
    return {
      network: {
        bootstrap: [{ host: "config.example", port: 49_737 }],
      },
      publisher: {
        enabled: true,
        displayName: "neilmac",
        allow: ["33".repeat(32)],
        services: [],
      },
      subscriber: {
        enabled: true,
        gatewayPort: 17_480,
        gatewayHost: "0.0.0.0",
        gatewayDomain: "kepos.internal",
        route: "auto" as const,
        services: [{ id: "ignored", localPort: 9_999 }],
      },
    };
  };

  await runCli(
    [
      "device",
      "run",
      "--publisher-state",
      "./publisher",
      "--subscriber-state",
      "./subscriber",
      "--config",
      "./kepos.toml",
      "--bootstrap",
      "cli.example:49738",
      "--subscriber-service",
      "ssh:2222",
      "--gateway-port",
      "18080",
      "--route",
      "public",
    ],
    cli.dependencies,
  );

  assert.equal(cli.calls.startDevice.length, 1);
  const [options] = cli.calls.startDevice as Array<{
    bootstrap: Array<{ host: string; port: number }>;
    publisher?: { stateDir: string; policy?: unknown };
    subscriber?: {
      stateDir: string;
      gatewayPort?: number;
      gatewayHost?: string;
      gatewayDomain?: string;
      route?: string;
      services: Array<{ id: string; localPort: number }>;
      waitForPublisher?: boolean;
    };
  }>;
  assert.deepEqual(options.bootstrap, [
    { host: "cli.example", port: 49_738 },
  ]);
  assert.equal(options.publisher?.stateDir, path.resolve("./publisher"));
  assert.deepEqual(options.publisher?.policy, {
    enabled: true,
    displayName: "neilmac",
    allow: ["33".repeat(32)],
    services: [],
  });
  assert.deepEqual(
    {
      ...options.subscriber,
      observe: undefined,
    },
    {
      stateDir: path.resolve("./subscriber"),
      gatewayPort: 18_080,
      gatewayHost: "0.0.0.0",
      gatewayDomain: "kepos.internal",
      route: "public",
      services: [{ id: "ssh", localPort: 2_222 }],
      waitForPublisher: false,
      observe: undefined,
    },
  );
  assert.deepEqual(cli.calls.runtime, [
    `publisher.acquire:${path.resolve("./publisher")}`,
    `subscriber.acquire:${path.resolve("./subscriber")}`,
    "device.start",
    "device.stop",
    `subscriber.release:${path.resolve("./subscriber")}`,
    `publisher.release:${path.resolve("./publisher")}`,
  ]);
  assert.deepEqual(cli.calls.stopped, ["device"]);
  assert.match(cli.stdout.join("\n"), /Publisher running:/);
  assert.match(cli.stdout.join("\n"), /Subscriber running:/);
  assert.match(cli.stdout.join("\n"), /Local service: ssh=127\.0\.0\.1:2222/);
});

test("device run does not add roles from enabled config", async () => {
  const cli = fakeCli();
  cli.dependencies.loadConfig = async () => ({
    publisher: {
      enabled: true,
      displayName: "neilmac",
      allow: [],
      services: [],
    },
    subscriber: {
      enabled: true,
      services: [],
    },
  });

  await runCli(
    ["device", "run", "--publisher-state", "./publisher"],
    cli.dependencies,
  );

  const [options] = cli.calls.startDevice as Array<{
    publisher?: unknown;
    subscriber?: unknown;
  }>;
  assert.ok(options.publisher);
  assert.equal(options.subscriber, undefined);
  assert.deepEqual(cli.calls.subscriberLocks, []);
});

test("device run rolls back the publisher lock when subscriber lock fails", async () => {
  const cli = fakeCli();
  cli.dependencies.acquireSubscriberRuntimeLock = async (stateDir) => {
    cli.calls.subscriberLocks.push(`acquire:${stateDir}`);
    cli.calls.runtime.push(`subscriber.acquire:${stateDir}`);
    throw new Error("subscriber already running");
  };

  await assert.rejects(
    runCli(
      [
        "device",
        "run",
        "--publisher-state",
        "./publisher",
        "--subscriber-state",
        "./subscriber",
      ],
      cli.dependencies,
    ),
    /subscriber already running/,
  );
  assert.deepEqual(cli.calls.runtime, [
    `publisher.acquire:${path.resolve("./publisher")}`,
    `subscriber.acquire:${path.resolve("./subscriber")}`,
    `publisher.release:${path.resolve("./publisher")}`,
  ]);
  assert.deepEqual(cli.calls.startDevice, []);
});

test("device run releases both locks when shared startup fails", async () => {
  const cli = fakeCli();
  cli.dependencies.startDevice = async () => {
    cli.calls.runtime.push("device.start");
    throw new Error("device startup failed");
  };

  await assert.rejects(
    runCli(
      [
        "device",
        "run",
        "--publisher-state",
        "./publisher",
        "--subscriber-state",
        "./subscriber",
      ],
      cli.dependencies,
    ),
    /device startup failed/,
  );
  assert.deepEqual(cli.calls.runtime, [
    `publisher.acquire:${path.resolve("./publisher")}`,
    `subscriber.acquire:${path.resolve("./subscriber")}`,
    "device.start",
    `subscriber.release:${path.resolve("./subscriber")}`,
    `publisher.release:${path.resolve("./publisher")}`,
  ]);
});

test("device run requires an explicit role state", async () => {
  const cli = fakeCli();

  await assert.rejects(
    runCli(["device", "run"], cli.dependencies),
    /device run requires --publisher-state or --subscriber-state/,
  );
  assert.deepEqual(cli.calls.startDevice, []);
});

test("device run rejects subscriber overrides without subscriber state", async () => {
  for (const override of [
    ["--subscriber-service", "ssh:2222"],
    ["--gateway-port", "18080"],
    ["--gateway-host", "0.0.0.0"],
    ["--gateway-domain", "kepos.internal"],
    ["--route", "public"],
  ]) {
    const cli = fakeCli();
    await assert.rejects(
      runCli(
        [
          "device",
          "run",
          "--publisher-state",
          "./publisher",
          ...override,
        ],
        cli.dependencies,
      ),
      /subscriber options require --subscriber-state/,
    );
    assert.deepEqual(cli.calls.startDevice, []);
  }
});

test("setup publisher parses deny-all state and service targets", async () => {
  const cli = fakeCli();
  await runCli(
    [
      "setup",
      "publisher",
      "--state",
      "./publisher",
      "--display-name",
      "kosmos",
      "--service",
      "ssh:SSH:22",
    ],
    cli.dependencies,
  );

  assert.deepEqual(cli.calls.setupPublisher, [
    {
      stateDir: path.resolve("./publisher"),
      displayName: "kosmos",
      subscriberPublicKeys: [],
      services: [{ id: "ssh", name: "SSH", targetPort: 22 }],
    },
  ]);
  assert.deepEqual(cli.stdout, [`Publisher key: ${"11".repeat(32)}`]);
  assert.equal(cli.stdout.join("\n").includes("seed"), false);
});

test("publisher key reports the public key without policy input", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kepos-publisher-key-"));
  const stateDir = path.join(root, "publisher");
  const setup = await setupPublisher({
    stateDir,
    displayName: "kosmos",
    subscriberPublicKeys: [],
    services: [{ id: "ssh", name: "SSH", targetPort: 22 }],
  });
  const stdout: string[] = [];

  await runCli(
    ["publisher", "key", "--state", stateDir],
    createDefaultCliDependencies({ stdout: (line) => stdout.push(line) }),
  );

  assert.deepEqual(stdout, [`Publisher key: ${setup.publisherKey}`]);
  assert.doesNotMatch(stdout.join("\n"), /seed|secret/i);
});

test("setup subscriber and set-publisher expose only public state", async () => {
  const cli = fakeCli();
  await runCli(
    ["setup", "subscriber", "--state", "./subscriber"],
    cli.dependencies,
  );
  await runCli(
    [
      "subscriber",
      "set-publisher",
      "--state",
      "./subscriber",
      "--label",
      "kosmos",
      "--publisher-key",
      "11".repeat(32),
    ],
    cli.dependencies,
  );

  assert.deepEqual(cli.calls.setupSubscriber, [
    { stateDir: path.resolve("./subscriber") },
  ]);
  assert.deepEqual(cli.calls.setSubscriberPublisher, [
    {
      stateDir: path.resolve("./subscriber"),
      label: "kosmos",
      publisherKey: "11".repeat(32),
    },
  ]);
  assert.equal(cli.stdout[0], `Subscriber key: ${"22".repeat(32)}`);
});

test("publisher set commands replace allowlist and services", async () => {
  const cli = fakeCli();
  await runCli(
    ["publisher", "set-allow", "--state", "./publisher"],
    cli.dependencies,
  );
  await runCli(
    [
      "publisher",
      "set-services",
      "--state",
      "./publisher",
      "--service",
      "navidrome:Navidrome:4533",
    ],
    cli.dependencies,
  );

  assert.deepEqual(cli.calls.setPublisherAllowlist, [
    {
      stateDir: path.resolve("./publisher"),
      subscriberPublicKeys: [],
    },
  ]);
  assert.deepEqual(cli.calls.setPublisherServices, [
    {
      stateDir: path.resolve("./publisher"),
      services: [
        { id: "navidrome", name: "Navidrome", targetPort: 4533 },
      ],
    },
  ]);
});

test("publisher set commands reject TOML-owned policy", async () => {
  const cli = fakeCli();
  cli.dependencies.loadConfig = async (configPath) => {
    cli.calls.configPaths.push(configPath);
    return {
      publisher: {
        displayName: "kosmos",
        allow: [],
        services: [],
      },
    };
  };

  await assert.rejects(
    () =>
      runCli(
        [
          "publisher",
          "set-allow",
          "--state",
          "./publisher",
          "--config",
          "./kepos.toml",
        ],
        cli.dependencies,
      ),
    /publisher policy is managed by TOML; edit the config file/,
  );
  await assert.rejects(
    () =>
      runCli(
        ["publisher", "set-services", "--state", "./publisher"],
        cli.dependencies,
      ),
    /publisher policy is managed by TOML; edit the config file/,
  );

  assert.deepEqual(cli.calls.setPublisherAllowlist, []);
  assert.deepEqual(cli.calls.setPublisherServices, []);
  assert.deepEqual(cli.calls.configPaths, [
    path.resolve("./kepos.toml"),
    undefined,
  ]);
});

test("publisher run prints human status and awaits signal-safe stop", async () => {
  const cli = fakeCli();
  await runCli(
    [
      "publisher",
      "run",
      "--state",
      "./publisher",
      "--bootstrap",
      "bootstrap-one.example:49737",
      "--bootstrap",
      "bootstrap-two.example:49738",
    ],
    cli.dependencies,
  );

  assert.equal(cli.calls.startPublisher.length, 1);
  const [options] = cli.calls.startPublisher as Array<{
    stateDir: string;
    bootstrap: Array<{ host: string; port: number }>;
  }>;
  assert.equal(options.stateDir, path.resolve("./publisher"));
  assert.deepEqual(options.bootstrap, [
    { host: "bootstrap-one.example", port: 49737 },
    { host: "bootstrap-two.example", port: 49738 },
  ]);
  assert.deepEqual(cli.calls.stopped, ["publisher"]);
  assert.deepEqual(cli.calls.publisherLocks, [
    `acquire:${path.resolve("./publisher")}`,
    `release:${path.resolve("./publisher")}`,
  ]);
  assert.match(
    cli.stdout.join("\n"),
    /Publisher running: key=[0-9a-f]+ registry=http:\/\/127\.0\.0\.1:3000\/\.well-known\/kepos\/services\.json/,
  );
  assert.doesNotMatch(cli.stdout.join("\n"), / home=http:/);
  assert.match(cli.stdout.join("\n"), /outer\.connected/);
  assert.match(cli.stdout.join("\n"), /attempt=2/);
});

test("publisher run releases its identity lock when startup fails", async () => {
  const cli = fakeCli();
  cli.dependencies.startPublisher = async () => {
    throw new Error("publisher failed");
  };

  await assert.rejects(
    () =>
      runCli(
        ["publisher", "run", "--state", "./publisher"],
        cli.dependencies,
      ),
    /publisher failed/,
  );

  assert.deepEqual(cli.calls.publisherLocks, [
    `acquire:${path.resolve("./publisher")}`,
    `release:${path.resolve("./publisher")}`,
  ]);
});

test("run commands use TOML bootstrap unless the CLI overrides it", async () => {
  const cli = fakeCli();
  cli.dependencies.loadConfig = async (configPath) => {
    cli.calls.configPaths.push(configPath);
    return {
      network: {
        bootstrap: [{ host: "config.example.com", port: 49_737 }],
      },
    };
  };

  await runCli(
    [
      "subscriber",
      "run",
      "--state",
      "./subscriber",
      "--config",
      "./kepos.toml",
    ],
    cli.dependencies,
  );
  await runCli(
    [
      "publisher",
      "run",
      "--state",
      "./publisher",
      "--bootstrap",
      "cli.example.com:49738",
    ],
    cli.dependencies,
  );

  assert.deepEqual(cli.calls.configPaths, [
    path.resolve("./kepos.toml"),
    undefined,
  ]);
  assert.deepEqual(
    (cli.calls.startSubscriber[0] as { bootstrap: unknown }).bootstrap,
    [{ host: "config.example.com", port: 49_737 }],
  );
  assert.deepEqual(
    (cli.calls.startPublisher[0] as { bootstrap: unknown }).bootstrap,
    [{ host: "cli.example.com", port: 49_738 }],
  );
});

test("publisher setup and run use TOML publisher policy", async () => {
  const cli = fakeCli();
  const subscriberKey = "33".repeat(32);
  cli.dependencies.loadConfig = async (configPath) => {
    cli.calls.configPaths.push(configPath);
    return {
      publisher: {
        displayName: "kosmos",
        allow: [subscriberKey],
        services: [
          { id: "navidrome", name: "Navidrome", targetPort: 4_533 },
        ],
      },
    };
  };

  await runCli(
    ["setup", "publisher", "--state", "./publisher"],
    cli.dependencies,
  );
  await runCli(
    ["publisher", "run", "--state", "./publisher"],
    cli.dependencies,
  );

  assert.deepEqual(cli.calls.setupPublisher, [
    {
      stateDir: path.resolve("./publisher"),
      displayName: "kosmos",
      subscriberPublicKeys: [subscriberKey],
      services: [
        { id: "navidrome", name: "Navidrome", targetPort: 4_533 },
      ],
    },
  ]);
  assert.deepEqual(
    (cli.calls.startPublisher[0] as { policy: unknown }).policy,
    {
      displayName: "kosmos",
      allow: [subscriberKey],
      services: [
        { id: "navidrome", name: "Navidrome", targetPort: 4_533 },
      ],
    },
  );
});

test("publisher setup rejects CLI overrides of TOML policy", async () => {
  const cli = fakeCli();
  cli.dependencies.loadConfig = async () => ({
    publisher: {
      displayName: "kosmos",
      allow: [],
      services: [],
    },
  });

  await assert.rejects(
    () =>
      runCli(
        [
          "setup",
          "publisher",
          "--state",
          "./publisher",
          "--allow",
          "44".repeat(32),
        ],
        cli.dependencies,
      ),
    /publisher policy is managed by TOML; remove CLI policy options/,
  );
  assert.deepEqual(cli.calls.setupPublisher, []);
});

test("subscriber run uses TOML bindings and CLI overrides", async () => {
  const cli = fakeCli();
  cli.dependencies.loadConfig = async (configPath) => {
    cli.calls.configPaths.push(configPath);
    return {
      network: { bootstrap: [] },
      subscriber: {
        gatewayPort: 17_480,
        gatewayHost: "0.0.0.0",
        gatewayDomain: "kepos.internal",
        route: "auto",
        services: [{ id: "ssh", localPort: 2_222 }],
      },
    };
  };

  await runCli(
    ["subscriber", "run", "--state", "./subscriber"],
    cli.dependencies,
  );
  await runCli(
    [
      "subscriber",
      "run",
      "--state",
      "./subscriber",
      "--gateway-port",
      "18080",
      "--gateway-host",
      "127.0.0.2",
      "--gateway-domain",
      "cluster.internal",
      "--route",
      "public",
      "--service",
      "ssh:2200",
    ],
    cli.dependencies,
  );

  const [configured, overridden] = cli.calls.startSubscriber as Array<{
    bootstrap?: unknown;
    gatewayPort?: number;
    gatewayHost?: string;
    gatewayDomain?: string;
    route: string;
    services: Array<{ id: string; localPort: number }>;
  }>;
  assert.equal(configured.bootstrap, undefined);
  assert.equal(configured.gatewayPort, 17_480);
  assert.equal(configured.gatewayHost, "0.0.0.0");
  assert.equal(configured.gatewayDomain, "kepos.internal");
  assert.equal(configured.route, "auto");
  assert.deepEqual(configured.services, [{ id: "ssh", localPort: 2_222 }]);
  assert.equal(overridden.gatewayPort, 18_080);
  assert.equal(overridden.gatewayHost, "127.0.0.2");
  assert.equal(overridden.gatewayDomain, "cluster.internal");
  assert.equal(overridden.route, "public");
  assert.deepEqual(overridden.services, [{ id: "ssh", localPort: 2_200 }]);
});

test("subscriber run maps services and writes NDJSON observations", async () => {
  const cli = fakeCli();
  await runCli(
    [
      "subscriber",
      "run",
      "--state",
      "./subscriber",
      "--service",
      "ssh:2222",
      "--gateway-port",
      "18080",
      "--route",
      "public",
      "--bootstrap",
      "34.143.181.65:49738",
      "--observations",
      "ndjson",
    ],
    cli.dependencies,
  );

  const [options] = cli.calls.startSubscriber as Array<{
    stateDir: string;
    services: Array<{ id: string; localPort: number }>;
    gatewayPort: number;
    route: string;
    bootstrap: Array<{ host: string; port: number }>;
    waitForPublisher: boolean;
  }>;
  assert.equal(options.stateDir, path.resolve("./subscriber"));
  assert.deepEqual(options.services, [{ id: "ssh", localPort: 2222 }]);
  assert.equal(options.gatewayPort, 18_080);
  assert.equal(options.route, "public");
  assert.equal(options.waitForPublisher, false);
  assert.deepEqual(options.bootstrap, [
    { host: "34.143.181.65", port: 49738 },
  ]);
  assert.deepEqual(cli.calls.stopped, ["subscriber"]);
  assert.deepEqual(cli.calls.subscriberLocks, [
    `acquire:${path.resolve("./subscriber")}`,
    `release:${path.resolve("./subscriber")}`,
  ]);
  assert.equal(cli.stdout.length, 1);
  assert.equal(JSON.parse(cli.stdout[0] ?? "").event, "outer.connected");
  assert.match(
    cli.stderr.join("\n"),
    /Subscriber running: publisher=[0-9a-f]+ registry=http:\/\/127\.0\.0\.1:4000\/\.well-known\/kepos\/services\.json/,
  );
  assert.doesNotMatch(cli.stderr.join("\n"), / home=http:/);
});

test("subscriber run releases its identity lock when startup fails", async () => {
  const cli = fakeCli();
  cli.dependencies.startSubscriber = async () => {
    throw new Error("publisher unavailable");
  };

  await assert.rejects(
    () =>
      runCli(
        ["subscriber", "run", "--state", "./subscriber"],
        cli.dependencies,
      ),
    /publisher unavailable/,
  );

  assert.deepEqual(cli.calls.subscriberLocks, [
    `acquire:${path.resolve("./subscriber")}`,
    `release:${path.resolve("./subscriber")}`,
  ]);
});

test("run commands reject malformed bootstrap endpoints", async () => {
  const cli = fakeCli();

  await assert.rejects(
    () =>
      runCli(
        [
          "subscriber",
          "run",
          "--state",
          "./subscriber",
          "--bootstrap",
          "bootstrap.example",
        ],
        cli.dependencies,
      ),
    /bootstrap.*host:port/i,
  );
  await assert.rejects(
    () =>
      runCli(
        [
          "publisher",
          "run",
          "--state",
          "./publisher",
          "--bootstrap",
          "bootstrap.example:70000",
        ],
        cli.dependencies,
      ),
    /bootstrap.*port/i,
  );
});

test("canonical commands require explicit state and reject standalone status", async () => {
  const cli = fakeCli();
  await assert.rejects(
    () => runCli(["setup", "subscriber"], cli.dependencies),
    /--state is required/,
  );
  await assert.rejects(
    () => runCli(["status"], cli.dependencies),
    /unknown command|usage/i,
  );
});

test("empty arguments and help print CLI usage", async () => {
  const empty = fakeCli();
  const help = fakeCli();

  await runCli([], empty.dependencies);
  await runCli(["--help"], help.dependencies);

  assert.match(empty.stdout.join("\n"), /usage: kepos/i);
  assert.equal(help.stdout.join("\n"), empty.stdout.join("\n"));
});

test("partial commands report valid CLI usage", async () => {
  const cli = fakeCli();

  await assert.rejects(
    () => runCli(["publisher"], cli.dependencies),
    /unknown command: publisher[\s\S]*usage: kepos/i,
  );
});

test("signal wait removes handlers after one awaited stop", async () => {
  const beforeInt = process.listenerCount("SIGINT");
  const beforeTerm = process.listenerCount("SIGTERM");
  let stopped = 0;
  const waiting = waitForSignal(async () => {
    stopped++;
  });

  process.emit("SIGTERM", "SIGTERM");
  await waiting;

  assert.equal(stopped, 1);
  assert.equal(process.listenerCount("SIGINT"), beforeInt);
  assert.equal(process.listenerCount("SIGTERM"), beforeTerm);
});
