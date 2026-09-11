import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  createDefaultCliDependencies,
  runCli,
  type CliDependencies,
} from "../src/cli/main.js";
import {
  observationMode,
  parseBootstrapOptions,
  parseGatewayDomainOption,
  parseGatewayHostOption,
  parseGatewayPortOption,
  parseOptions,
  parseRouteOption,
  repeatedOption,
  requiredOption,
  requiredState,
  singleOption,
} from "../src/cli/options.js";
import { waitForSignal } from "../src/cli/signals.js";
import type { PeerConfig } from "../src/config.js";
import type { RunningPeer } from "../src/runtime/peer.js";
import { loadPeerIdentity, setupPeer } from "../src/state/peer.js";

const peerKey = "11".repeat(32);
const otherPeerKey = "22".repeat(32);

function emptyConfig(): PeerConfig {
  return { peers: [], services: [], bindings: [] };
}

test("setup peer and peer key create and reuse one canonical identity and config", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kepos-cli-peer-"));
  const stateDir = path.join(root, "state", "peer");
  const configPath = path.join(root, "config.toml");
  const stdout: string[] = [];
  try {
    const dependencies = createDefaultCliDependencies({ stdout: (line) => stdout.push(line) });
    await runCli(["setup", "peer", "--state", stateDir, "--config", configPath], dependencies);
    const firstKey = stdout.at(-1)?.slice("Peer key: ".length);
    assert.match(firstKey ?? "", /^[0-9a-f]{64}$/);
    stdout.length = 0;

    await runCli(["setup", "peer", "--state", stateDir, "--config", configPath], dependencies);
    assert.equal(stdout.at(-1), `Peer key: ${firstKey}`);
    stdout.length = 0;
    await runCli(["peer", "key", "--state", stateDir], dependencies);
    assert.deepEqual(stdout, [`Peer key: ${firstKey}`]);
    assert.match(await readFile(configPath, "utf8"), /peers = \[\]/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("peer pair edits only canonical trust and leaves service grants independent", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kepos-cli-pair-"));
  const configPath = path.join(root, "config.toml");
  const stateDir = path.join(root, "peer");
  const stdout: string[] = [];
  try {
    const dependencies = createDefaultCliDependencies({ stdout: (line) => stdout.push(line) });
    await runCli(["setup", "peer", "--state", stateDir, "--config", configPath], dependencies);
    await runCli(["peer", "pair", "--config", configPath, "--label", "phone", "--public-key", otherPeerKey], dependencies);
    const config = await dependencies.loadConfig(configPath);
    assert.deepEqual(config?.peers, [{ label: "phone", publicKey: otherPeerKey, connection: "accept" }]);
    assert.deepEqual(config?.services, []);
    assert.match(stdout.at(-1) ?? "", /Peer approved: phone/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("peer convert requires an expected key and preserves the selected identity", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kepos-cli-convert-"));
  const generatedDir = path.join(root, "generated");
  const source = path.join(root, "legacy-publisher");
  const destination = path.join(root, "peer");
  const stdout: string[] = [];
  try {
    await setupPeer({ stateDir: generatedDir });
    const identity = await loadPeerIdentity(generatedDir);
    await mkdir(source, { mode: 0o700 });
    await writeFile(path.join(source, "publisher.json"), JSON.stringify(identity), { mode: 0o600 });
    const dependencies = createDefaultCliDependencies({ stdout: (line) => stdout.push(line) });
    await runCli([
      "peer",
      "convert",
      "--source",
      source,
      "--destination",
      destination,
      "--expected-public-key",
      (await dependencies.getPeerPublicKey(generatedDir)),
    ], dependencies);
    assert.equal(stdout.at(-1), `Peer key: ${await dependencies.getPeerPublicKey(generatedDir)}`);
    await assert.rejects(
      runCli(["peer", "convert", "--source", source, "--destination", path.join(root, "missing-key")], dependencies),
      /--expected-public-key is required/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("peer status reads only canonical config and identity", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kepos-cli-status-"));
  const stateDir = path.join(root, "peer");
  const configPath = path.join(root, "config.toml");
  const stdout: string[] = [];
  try {
    const dependencies = createDefaultCliDependencies({ stdout: (line) => stdout.push(line) });
    const setup = await dependencies.setupPeer({ stateDir });
    await dependencies.saveConfig({
      peers: [{ label: "phone", publicKey: otherPeerKey, connection: "accept" }],
      services: [{ id: "ssh", name: "SSH", kind: "tcp", source: { localPort: 22 }, allow: [otherPeerKey] }],
      bindings: [],
    }, configPath);
    await runCli(["peer", "status", "--state", stateDir, "--config", configPath], dependencies);
    assert.deepEqual(JSON.parse(stdout.at(-1) ?? "null"), {
      role: "peer",
      state: "stopped",
      peerKey: setup.publicKey,
      config: { peers: 1, services: 1, bindings: 0 },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function fakeRunningPeer(events: string[]): RunningPeer {
  return {
    peerKey,
    gateway: { port: 17_480, url: "http://home.localhost:17480" },
    applyConfig: async () => {
      events.push("apply");
      return true;
    },
    open: async () => {
      throw new Error("not used");
    },
    status: () => ({
      role: "peer" as const,
      state: "running" as const,
      peerKey,
      gateway: { port: 17_480, url: "http://home.localhost:17480" },
      connections: [],
      services: [],
      bindings: [],
      pairing: { phase: "idle" as const },
    }),
    createPairingInvitation: () => ({ uri: "kepos://pair", expiresAt: Date.now() + 1000 }),
    pairingStatus: () => ({ phase: "idle" as const }),
    approvePairing: async () => undefined,
    denyPairing: () => undefined,
    cancelPairing: () => undefined,
    pair: async () => ({
      role: "peer" as const,
      state: "running" as const,
      peerKey,
      gateway: { port: 17_480, url: "http://home.localhost:17480" },
      connections: [],
      services: [],
      bindings: [],
      pairing: { phase: "idle" as const },
    }),
    stop: async () => {
      events.push("stop");
    },
  };
}

test("peer run owns the canonical lock, reloads serially, and stops the runtime", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kepos-cli-run-"));
  const stateDir = path.join(root, "peer");
  const configPath = path.join(root, "config.toml");
  const events: string[] = [];
  const stdout: string[] = [];
  let reload: (() => void) | undefined;
  let reads = 0;
  const running = fakeRunningPeer(events);
  const dependencies: CliDependencies = {
    ...createDefaultCliDependencies({ stdout: (line) => stdout.push(line) }),
    loadConfig: async () => {
      reads++;
      return emptyConfig();
    },
    acquirePeerRuntimeLock: async () => ({
      release: async () => {
        events.push("release");
      },
    }),
    startPeer: async (options) => {
      events.push("start");
      options.observe?.({
        component: "kepos",
        event: "outer.connected",
        timestamp: "ignored",
        elapsedMs: 0,
        role: "peer",
        text: "value",
        count: 2,
        enabled: true,
        empty: null,
        nested: { value: "json" },
      });
      return running;
    },
    scheduleConfigReload: (callback) => {
      reload = callback;
      return () => events.push("cancel-reload");
    },
    waitForSignal: async (stop) => {
      reload?.();
      await stop();
    },
  };
  try {
    await runCli(["peer", "run", "--state", stateDir, "--config", configPath], dependencies);
    assert.deepEqual(events, ["start", "cancel-reload", "apply", "stop", "stop", "release"]);
    assert.equal(reads, 2);
    assert.match(stdout.join("\n"), /Peer running: key=/);
    assert.match(stdout.join("\n"), /outer.connected elapsedMs=0 role=peer text=value count=2 enabled=true empty=null nested=\{"value":"json"\}/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("removed role commands and flags are rejected", async () => {
  const dependencies = createDefaultCliDependencies({ stdout: () => undefined });
  for (const arguments_ of [
    ["setup", "publisher"],
    ["setup", "subscriber"],
    ["publisher", "run"],
    ["subscriber", "run"],
    ["device", "run"],
    ["peer", "run", "--publisher-state", "legacy"],
  ]) {
    await assert.rejects(runCli(arguments_, dependencies), /unknown command|unknown option/i);
  }
});

test("canonical CLI option parsers validate and normalize supported values", () => {
  const options = parseOptions([
    "--state", "./peer",
    "--label", "phone",
    "--bootstrap", "127.0.0.1:49737",
    "--bootstrap", "bootstrap.example:49738",
    "--route", "public",
    "--gateway-port", "17480",
    "--gateway-host", "127.0.0.1",
    "--gateway-domain", "Peers.Example",
    "--observations", "ndjson",
  ], [
    "--state", "--label", "--bootstrap", "--route",
    "--gateway-port", "--gateway-host", "--gateway-domain", "--observations",
  ]);

  assert.equal(requiredState(options), path.resolve("./peer"));
  assert.equal(requiredOption(options, "--label"), "phone");
  assert.deepEqual(repeatedOption(options, "--bootstrap"), ["127.0.0.1:49737", "bootstrap.example:49738"]);
  assert.equal(parseRouteOption(options), "public");
  assert.equal(parseGatewayPortOption(options), 17480);
  assert.equal(parseGatewayHostOption(options), "127.0.0.1");
  assert.equal(parseGatewayDomainOption(options), "peers.example");
  assert.deepEqual(parseBootstrapOptions(options), [
    { host: "127.0.0.1", port: 49737 },
    { host: "bootstrap.example", port: 49738 },
  ]);
  assert.equal(observationMode(options), "ndjson");
  assert.equal(singleOption(options, "--missing"), undefined);

  assert.equal(parseRouteOption(parseOptions([], ["--route"])), "auto");
  assert.equal(parseGatewayPortOption(parseOptions([], ["--gateway-port"])), undefined);
  assert.equal(parseGatewayHostOption(parseOptions([], ["--gateway-host"])), undefined);
  assert.equal(parseGatewayDomainOption(parseOptions([], ["--gateway-domain"])), undefined);
  assert.equal(parseBootstrapOptions(parseOptions([], ["--bootstrap"])), undefined);
  assert.equal(observationMode(parseOptions([], ["--observations"])), "human");

  assert.throws(() => parseOptions(["--unknown", "value"], ["--state"]), /unknown option/);
  assert.throws(() => parseOptions(["--state"], ["--state"]), /requires a value/);
  assert.throws(() => requiredState(parseOptions([], ["--state"])), /--state is required/);
  assert.throws(() => requiredOption(parseOptions([], ["--label"]), "--label"), /required/);
  assert.throws(() => singleOption(parseOptions(["--label", "a", "--label", "b"], ["--label"]), "--label"), /may be used only once/);
  assert.throws(() => parseBootstrapOptions(parseOptions(["--bootstrap", "bad"], ["--bootstrap"])), /host:port/);
  assert.throws(() => observationMode(parseOptions(["--observations", "json"], ["--observations"])), /human or ndjson/);
});

test("waitForSignal stops once and removes every signal listener", async () => {
  let stopCalls = 0;
  let releaseStop!: () => void;
  const stopped = new Promise<void>((resolve) => {
    releaseStop = resolve;
  });
  const waiting = waitForSignal(async () => {
    stopCalls++;
    await stopped;
  });
  process.emit("SIGINT");
  process.emit("SIGTERM");
  assert.equal(stopCalls, 1);
  releaseStop();
  await waiting;
  process.emit("SIGINT");
  assert.equal(stopCalls, 1);

  const rejected = waitForSignal(async () => {
    throw new Error("stop failed");
  });
  process.emit("SIGTERM");
  await assert.rejects(rejected, /stop failed/);
});

test("canonical CLI handles missing, existing, and failing command state", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kepos-cli-edges-"));
  const stdout: string[] = [];
  const stderr: string[] = [];
  const base = createDefaultCliDependencies({
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });
  try {
    await runCli([], base);
    await runCli(["--help"], base);
    assert.equal(stdout.filter((line) => line.startsWith("Usage:")).length, 2);

    const stateDir = path.join(root, "peer");
    const configPath = path.join(root, "config.toml");
    let saves = 0;
    const existingConfig = emptyConfig();
    await runCli(["setup", "peer", "--state", stateDir, "--config", configPath], {
      ...base,
      setupPeer: async () => ({ created: false, publicKey: peerKey }),
      loadConfig: async () => existingConfig,
      saveConfig: async () => {
        saves++;
      },
    });
    assert.equal(saves, 0);

    await assert.rejects(
      runCli(["setup", "peer", "--state", stateDir, "--config", configPath], {
        ...base,
        setupPeer: async () => ({ created: false, publicKey: peerKey }),
        loadConfig: async () => {
          throw new Error("config is unreadable");
        },
      }),
      /config is unreadable/,
    );

    await runCli(["peer", "status", "--state", stateDir, "--config", configPath], {
      ...base,
      loadConfig: async () => undefined,
      getPeerPublicKey: async () => peerKey,
    });
    assert.deepEqual(JSON.parse(stdout.at(-1) ?? "null").config, {
      peers: 0,
      services: 0,
      bindings: 0,
    });

    let paired: PeerConfig | undefined;
    await runCli([
      "peer",
      "pair",
      "--config",
      configPath,
      "--label",
      "dial-peer",
      "--public-key",
      otherPeerKey,
      "--connection",
      "dial",
    ], {
      ...base,
      loadConfig: async () => existingConfig,
      saveConfig: async (config) => {
        paired = config;
      },
    });
    assert.equal(paired?.peers[0]?.connection, "dial");
    await assert.rejects(
      runCli([
        "peer",
        "pair",
        "--config",
        configPath,
        "--label",
        "bad",
        "--public-key",
        otherPeerKey,
        "--connection",
        "sideways",
      ], base),
      /dial or accept/,
    );

    await assert.rejects(
      runCli(["peer", "run", "--state", stateDir, "--config", configPath], {
        ...base,
        loadConfig: async () => undefined,
      }),
      /requires a canonical config/,
    );

    let released = 0;
    await assert.rejects(
      runCli(["peer", "run", "--state", stateDir, "--config", configPath], {
        ...base,
        loadConfig: async () => emptyConfig(),
        acquirePeerRuntimeLock: async () => ({
          release: async () => {
            released++;
          },
        }),
        startPeer: async () => {
          throw new Error("peer startup failed");
        },
      }),
      /peer startup failed/,
    );
    assert.equal(released, 1);

    const events: string[] = [];
    const running = fakeRunningPeer(events);
    await runCli([
      "peer",
      "run",
      "--state",
      stateDir,
      "--config",
      configPath,
      "--observations",
      "ndjson",
    ], {
      ...base,
      loadConfig: async () => emptyConfig(),
      acquirePeerRuntimeLock: async () => ({ release: async () => undefined }),
      startPeer: async (options) => {
        options.observe?.({
          component: "kepos",
          event: "outer.connected",
          timestamp: "2026-01-01T00:00:00.000Z",
          elapsedMs: 1,
          role: "peer",
        });
        return running;
      },
      scheduleConfigReload: () => () => undefined,
      waitForSignal: async (stop) => stop(),
    });
    assert.match(stderr.join("\n"), /Peer running: key=/);
    assert.match(stdout.join("\n"), /\"event\":\"outer.connected\"/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
