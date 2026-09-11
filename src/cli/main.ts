import path from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";

import {
  loadKeposConfig,
  saveKeposConfig,
  type KeposConfig,
} from "../app-config.js";
import {
  parsePeerConfig,
  type PeerConfig,
  type PeerConnectionDirection,
} from "../config.js";
import {
  getPeerPublicKey,
  setupPeer,
  convertPeerIdentity,
  type SetupPeerResult,
} from "../state/peer.js";
import {
  defaultKeposConfigPath,
  defaultKeposPeerStatePath,
} from "../platform/paths.js";
import {
  acquirePeerRuntimeLock,
  type RuntimeLock,
} from "../runtime/runtime-lock.js";
import {
  startPeer,
  type RunningPeer,
  type StartPeerOptions,
} from "../runtime/peer.js";
import type { Observation, Observe } from "../mux/observability.js";
import { waitForSignal } from "./signals.js";

export interface CliDependencies {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  loadConfig: (configPath?: string) => Promise<KeposConfig | undefined>;
  saveConfig: (config: PeerConfig, configPath: string) => Promise<void>;
  setupPeer: (options: { stateDir: string }) => Promise<SetupPeerResult>;
  getPeerPublicKey: (stateDir: string) => Promise<string>;
  convertPeerIdentity: typeof convertPeerIdentity;
  startPeer: (options: StartPeerOptions) => Promise<RunningPeer>;
  acquirePeerRuntimeLock: (stateDir: string) => Promise<RuntimeLock>;
  waitForSignal: (stop: () => Promise<void>) => Promise<void>;
  scheduleConfigReload: (callback: () => void, intervalMs: number) => () => void;
}

export function createDefaultCliDependencies(
  output: Partial<Pick<CliDependencies, "stdout" | "stderr">> = {},
): CliDependencies {
  return {
    stdout: output.stdout ?? console.log,
    stderr: output.stderr ?? console.error,
    loadConfig: loadKeposConfig,
    saveConfig: saveKeposConfig,
    setupPeer,
    getPeerPublicKey,
    convertPeerIdentity,
    startPeer,
    acquirePeerRuntimeLock,
    waitForSignal,
    scheduleConfigReload: (callback, intervalMs) => {
      const timer = setInterval(callback, intervalMs);
      return () => clearInterval(timer);
    },
  };
}

const defaultDependencies = createDefaultCliDependencies();

export const CLI_USAGE = [
  "Usage: kepos <command> [options]",
  "",
  "Commands:",
  "  setup peer       Initialize one canonical peer identity",
  "  peer key         Print the public key for a peer state directory",
  "  peer status      Inspect canonical configuration and runtime state",
  "  peer pair        Add an explicitly approved peer to the config",
  "  peer convert     Offline-convert one selected legacy identity",
  "  peer run         Run the canonical peer runtime",
].join("\n");

export async function runCli(
  arguments_: readonly string[],
  dependencies: CliDependencies = defaultDependencies,
): Promise<void> {
  if (
    arguments_.length === 0 ||
    arguments_.includes("--help") ||
    arguments_.includes("-h")
  ) {
    dependencies.stdout(CLI_USAGE);
    return;
  }
  const [group, action, ...rest] = arguments_;
  if (group === "setup" && action === "peer") {
    await setupPeerCommand(rest, dependencies);
    return;
  }
  if (group === "peer" && action === "key") {
    await peerKeyCommand(rest, dependencies);
    return;
  }
  if (group === "peer" && action === "status") {
    await peerStatusCommand(rest, dependencies);
    return;
  }
  if (group === "peer" && (action === "pair" || action === "trust")) {
    await peerPairCommand(rest, dependencies);
    return;
  }
  if (group === "peer" && action === "convert") {
    await peerConvertCommand(rest, dependencies);
    return;
  }
  if (group === "peer" && action === "run") {
    await peerRunCommand(rest, dependencies);
    return;
  }
  throw new Error(`unknown command: ${arguments_.join(" ")}\n\n${CLI_USAGE}`);
}

async function setupPeerCommand(
  arguments_: readonly string[],
  dependencies: CliDependencies,
): Promise<void> {
  const options = parseArguments(arguments_, ["--state", "--config"]);
  const stateDir = path.resolve(
    options.get("--state") ?? defaultKeposPeerStatePath(),
  );
  const result = await dependencies.setupPeer({ stateDir });
  const configPath = path.resolve(
    options.get("--config") ?? defaultKeposConfigPath(),
  );
  let existing: KeposConfig | undefined;
  try {
    existing = await dependencies.loadConfig(configPath);
  } catch (error) {
    if (!isMissingConfigError(error)) throw error;
  }
  if (!existing) {
    await dependencies.saveConfig(emptyPeerConfig(), configPath);
  }
  dependencies.stdout(`Peer key: ${result.publicKey}`);
}

async function peerKeyCommand(
  arguments_: readonly string[],
  dependencies: CliDependencies,
): Promise<void> {
  const options = parseArguments(arguments_, ["--state"]);
  const stateDir = path.resolve(
    options.get("--state") ?? defaultKeposPeerStatePath(),
  );
  dependencies.stdout(`Peer key: ${await dependencies.getPeerPublicKey(stateDir)}`);
}

async function peerStatusCommand(
  arguments_: readonly string[],
  dependencies: CliDependencies,
): Promise<void> {
  const options = parseArguments(arguments_, ["--state", "--config"]);
  const configPath = path.resolve(
    options.get("--config") ?? defaultKeposConfigPath(),
  );
  const config = await dependencies.loadConfig(configPath);
  const stateDir = path.resolve(
    options.get("--state") ?? defaultKeposPeerStatePath(),
  );
  const peerKey = await dependencies.getPeerPublicKey(stateDir);
  const canonical = config === undefined ? undefined : parsePeerConfig(config);
  dependencies.stdout(
    JSON.stringify({
      role: "peer",
      state: "stopped",
      peerKey,
      config: canonical
        ? {
            peers: canonical.peers.length,
            services: canonical.services.length,
            bindings: canonical.bindings.length,
          }
        : { peers: 0, services: 0, bindings: 0 },
    }),
  );
}

async function peerPairCommand(
  arguments_: readonly string[],
  dependencies: CliDependencies,
): Promise<void> {
  const options = parseArguments(arguments_, [
    "--config",
    "--label",
    "--public-key",
    "--connection",
  ]);
  const configPath = path.resolve(
    options.get("--config") ?? defaultKeposConfigPath(),
  );
  const label = required(options, "--label");
  const publicKey = required(options, "--public-key");
  const connection = (options.get("--connection") ?? "accept") as PeerConnectionDirection;
  if (connection !== "dial" && connection !== "accept") {
    throw new Error("--connection must be dial or accept");
  }
  const existing = await dependencies.loadConfig(configPath);
  const next = parsePeerConfig({
    ...(existing?.network ? { network: existing.network } : {}),
    ...(existing?.gateway ? { gateway: existing.gateway } : {}),
    peers: [
      ...(existing?.peers ?? []).filter(
        (peer) => peer.publicKey !== publicKey && peer.label !== label,
      ),
      { label, publicKey, connection },
    ],
    services: existing?.services ?? [],
    bindings: existing?.bindings ?? [],
  });
  await dependencies.saveConfig(next, configPath);
  dependencies.stdout(`Peer approved: ${label} (${publicKey})`);
}

async function peerConvertCommand(
  arguments_: readonly string[],
  dependencies: CliDependencies,
): Promise<void> {
  const options = parseArguments(arguments_, [
    "--source",
    "--destination",
    "--expected-public-key",
  ]);
  const result = await dependencies.convertPeerIdentity({
    source: required(options, "--source"),
    destination: required(options, "--destination"),
    ...(options.get("--expected-public-key")
      ? { expectedPublicKey: options.get("--expected-public-key") }
      : {}),
  });
  dependencies.stdout(`Peer key: ${result.publicKey}`);
}

async function peerRunCommand(
  arguments_: readonly string[],
  dependencies: CliDependencies,
): Promise<void> {
  const options = parseArguments(arguments_, ["--state", "--config", "--observations"]);
  const mode = options.get("--observations") ?? "human";
  if (mode !== "human" && mode !== "ndjson") {
    throw new Error("--observations must be human or ndjson");
  }
  const configPath = path.resolve(
    options.get("--config") ?? defaultKeposConfigPath(),
  );
  const stateDir = path.resolve(
    options.get("--state") ?? defaultKeposPeerStatePath(),
  );
  const config = requireConfig(await dependencies.loadConfig(configPath));
  const lock = await dependencies.acquirePeerRuntimeLock(stateDir);
  let cancelReload: (() => void) | undefined;
  let reloadTask = Promise.resolve();
  let running: RunningPeer | undefined;
  try {
    const started = await dependencies.startPeer({
      stateDir,
      config,
      observe: observationWriter(mode, dependencies),
    });
    running = started;
    const writeStatus = (line: string): void => {
      if (mode === "ndjson") dependencies.stderr(line);
      else dependencies.stdout(line);
    };
    writeStatus(
      `Peer running: key=${started.peerKey} gateway=${started.gateway.url}`,
    );
    cancelReload = dependencies.scheduleConfigReload(() => {
      reloadTask = reloadTask.then(async () => {
        try {
          const nextConfig = requireConfig(await dependencies.loadConfig(configPath));
          await started.applyConfig(nextConfig);
        } catch (error) {
          dependencies.stderr(`Peer config reload failed: ${errorMessage(error)}`);
        }
      });
    }, 1_000);
    const stop = async (): Promise<void> => {
      cancelReload?.();
      cancelReload = undefined;
      await reloadTask;
      await running?.stop();
    };
    await dependencies.waitForSignal(stop);
  } finally {
    cancelReload?.();
    await reloadTask;
    await running?.stop();
    await lock.release();
  }
}

function emptyPeerConfig(): PeerConfig {
  return { peers: [], services: [], bindings: [] };
}

function requireConfig(config: KeposConfig | undefined): PeerConfig {
  if (!config) throw new Error("peer run requires a canonical config.toml");
  return parsePeerConfig(config);
}

function parseArguments(
  arguments_: readonly string[],
  allowed: readonly string[],
): Map<string, string> {
  const values = new Map<string, string>();
  const allowedSet = new Set(allowed);
  for (let index = 0; index < arguments_.length; index += 2) {
    const option = arguments_[index];
    if (!option || !allowedSet.has(option)) {
      throw new Error(`unknown option: ${option ?? ""}`);
    }
    const value = arguments_[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${option} requires a value`);
    }
    if (values.has(option)) throw new Error(`${option} may be used only once`);
    values.set(option, value);
  }
  return values;
}

function required(options: Map<string, string>, option: string): string {
  const value = options.get(option);
  if (!value) throw new Error(`${option} is required`);
  return value;
}

function observationWriter(
  mode: "human" | "ndjson",
  dependencies: CliDependencies,
): Observe {
  return mode === "ndjson"
    ? (observation) => dependencies.stdout(JSON.stringify(observation))
    : (observation) => dependencies.stdout(formatObservation(observation));
}

function formatObservation(observation: Observation): string {
  const { component: _component, event, timestamp: _timestamp, ...fields } = observation;
  const details = Object.entries(fields)
    .map(([key, value]) => `${key}=${formatObservationValue(value)}`)
    .join(" ");
  return `${event}${details ? ` ${details}` : ""}`;
}

function formatObservationValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return String(value);
  }
  return JSON.stringify(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingConfigError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const cause = error.cause;
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    cause.code === "ENOENT"
  );
}

const invokedPath = process.argv[1];
if (
  invokedPath &&
  import.meta.url === pathToFileURL(path.resolve(invokedPath)).href
) {
  runCli(process.argv.slice(2)).catch((error: unknown) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}
