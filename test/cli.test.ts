import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
  parseMetricsListenOption,
  parseOptions,
  parseRouteOption,
  parseSubscriberService,
  repeatedOption,
  requiredOption,
  requiredState,
  singleOption,
} from "../src/cli/options.js";
import type { PeerConfig } from "../src/config.js";
import type { RunningPeer } from "../src/runtime/peer.js";
import { setupPublisher } from "../src/state/publisher.js";

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

test("peer pair owns explicit trust without broadening service grants", async () => {
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

test("peer convert is explicit offline identity selection and preserves the old public key", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kepos-cli-convert-"));
  const source = path.join(root, "legacy-publisher");
  const destination = path.join(root, "peer");
  const stdout: string[] = [];
  try {
    const legacy = await setupPublisher({ stateDir: source });
    const dependencies = createDefaultCliDependencies({ stdout: (line) => stdout.push(line) });
    await runCli([
      "peer",
      "convert",
      "--source",
      source,
      "--destination",
      destination,
      "--expected-public-key",
      legacy.publisherKey,
    ], dependencies);
    assert.equal(stdout.at(-1), `Peer key: ${legacy.publisherKey}`);
    await assert.rejects(
      runCli(["peer", "convert", "--source", source, "--destination", destination], dependencies),
      /expected|destination|exists/i,
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
  const config: PeerConfig = emptyConfig();
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
  const config = emptyConfig();
  const running = fakeRunningPeer(events);
  const dependencies: CliDependencies = {
    ...createDefaultCliDependencies({ stdout: (line) => stdout.push(line) }),
    loadConfig: async () => {
      reads++;
      return config;
    },
    acquirePeerRuntimeLock: async () => ({
      release: async () => {
        events.push("release");
      },
    }),
    startPeer: async () => {
      events.push("start");
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
    "--metrics-listen", "[::1]:9464",
    "--route", "public",
    "--gateway-port", "17480",
    "--gateway-host", "127.0.0.1",
    "--gateway-domain", "Peers.Example",
    "--observations", "ndjson",
  ], [
    "--state", "--label", "--bootstrap", "--metrics-listen", "--route",
    "--gateway-port", "--gateway-host", "--gateway-domain", "--observations",
  ]);

  assert.equal(requiredState(options), path.resolve("./peer"));
  assert.equal(requiredOption(options, "--label"), "phone");
  assert.deepEqual(repeatedOption(options, "--bootstrap"), [
    "127.0.0.1:49737",
    "bootstrap.example:49738",
  ]);
  assert.deepEqual(parseMetricsListenOption(options), { host: "::1", port: 9464 });
  assert.equal(parseRouteOption(options), "public");
  assert.equal(parseGatewayPortOption(options), 17480);
  assert.equal(parseGatewayHostOption(options), "127.0.0.1");
  assert.equal(parseGatewayDomainOption(options), "peers.example");
  assert.deepEqual(parseBootstrapOptions(options), [
    { host: "127.0.0.1", port: 49737 },
    { host: "bootstrap.example", port: 49738 },
  ]);
  assert.equal(observationMode(options), "ndjson");
  assert.deepEqual(parseSubscriberService("ssh:2222"), {
    id: "ssh",
    localPort: 2222,
  });
  assert.deepEqual(parseSubscriberService("game:udp:0"), {
    id: "game",
    kind: "udp",
    localPort: 0,
  });

  assert.deepEqual(parseMetricsListenOption(parseOptions(
    ["--metrics-listen", "127.0.0.1:0"],
    ["--metrics-listen"],
  )), { host: "127.0.0.1", port: 0 });
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
  assert.throws(() => singleOption(
    parseOptions(["--label", "a", "--label", "b"], ["--label"]),
    "--label",
  ), /may be used only once/);
  assert.throws(() => parseMetricsListenOption(parseOptions(
    ["--metrics-listen", "bad"],
    ["--metrics-listen"],
  )), /host:port/);
  assert.throws(() => parseBootstrapOptions(parseOptions(
    ["--bootstrap", "bad"],
    ["--bootstrap"],
  )), /host:port/);
  assert.throws(() => observationMode(parseOptions(
    ["--observations", "json"],
    ["--observations"],
  )), /human or ndjson/);
  assert.throws(() => parseSubscriberService("home:22"), /non-reserved/);
});
