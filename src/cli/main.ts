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
import { waitForSignal } from "./signals.js";

export interface CliDependencies {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  loadConfig: (configPath?: string) => Promise<KeposConfig | undefined>;
  saveConfig: (config: PeerConfig, configPath: string) => Promise<void>;
  setupPeer: (options: { stateDir: string }) => Promise<SetupPeerResult>;
  getPeerPublicKey: (stateDir: string) => Promise<string>;
  startVpn: typeof import("../vpn/runtime.js").startVpn;
  acquirePeerRuntimeLock: (stateDir: string) => Promise<RuntimeLock>;
  waitForSignal: (stop: () => Promise<void>, signal?: AbortSignal) => Promise<void>;
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
    startVpn: async (options) => (await import("../vpn/runtime.js")).startVpn(options),
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
  "  peer status      Inspect identity and configuration",
  "  peer pair        Add an explicitly approved peer to the config",
  "  peer vpn         Run the exclusive Linux VPN runtime",
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
  if (group === "peer" && action === "pair") {
    await peerPairCommand(rest, dependencies);
    return;
  }
  if (group === "peer" && action === "vpn") {
    await peerVpnCommand(rest, dependencies);
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
      peerKey,
      config: canonical
        ? {
            peers: canonical.peers.length,
          }
        : { peers: 0 },
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
  const conflict = existing?.peers.find((peer) =>
    (peer.label === label || peer.publicKey === publicKey) &&
    (peer.label !== label || peer.publicKey !== publicKey),
  );
  if (conflict) throw new Error("peer label or public key belongs to a different peer");
  const next = parsePeerConfig({
    ...existing,
    peers: [
      ...(existing?.peers ?? []).filter(
        (peer) => peer.publicKey !== publicKey && peer.label !== label,
      ),
      { label, publicKey, connection },
    ],
  });
  await dependencies.saveConfig(next, configPath);
  dependencies.stdout(`Peer approved: ${label} (${publicKey})`);
}

async function peerVpnCommand(arguments_: readonly string[], dependencies: CliDependencies): Promise<void> {
  const options = parseArguments(arguments_, ["--state", "--config", "--tun-helper"]);
  const stateDir = path.resolve(options.get("--state") ?? defaultKeposPeerStatePath());
  const configPath = path.resolve(options.get("--config") ?? defaultKeposConfigPath());
  const helper = path.resolve(required(options, "--tun-helper"));
  const config = requireConfig(await dependencies.loadConfig(configPath));
  const lock = await dependencies.acquirePeerRuntimeLock(stateDir);
  let running: Awaited<ReturnType<CliDependencies["startVpn"]>> | undefined;
  let cancelReload: (() => void) | undefined;
  let reloadTask = Promise.resolve();
  let closing = false;
  const signalAbort = new AbortController();
  let signalTask: Promise<void> | undefined;
  let fatal!: (error: Error) => void;
  const failed = new Promise<Error>((resolve) => { fatal = resolve; });
  async function start(next: PeerConfig): Promise<void> {
    const instance = await dependencies.startVpn({ stateDir, config: next, helper, log: dependencies.stderr });
    running = instance;
    void instance.failed.then((error) => { if (!closing && running === instance) fatal(error); });
    dependencies.stdout(`VPN running: key=${instance.peerKey} interface=${instance.interfaceName}`);
  }
  let current = JSON.stringify(config);
  try {
    await start(config);
    cancelReload = dependencies.scheduleConfigReload(() => {
      reloadTask = reloadTask.then(async () => {
        if (closing) return;
        try {
          const next = requireConfig(await dependencies.loadConfig(configPath));
          const serialized = JSON.stringify(next);
          if (serialized === current) return;
          await running?.stop();
          running = undefined;
          current = serialized;
          await start(next);
        } catch (error) {
          fatal(error instanceof Error ? error : new Error(String(error)));
        }
      });
    }, 1000);
    const stop = async (): Promise<void> => {
      closing = true;
      cancelReload?.();
      await reloadTask;
      await running?.stop();
    };
    signalTask = dependencies.waitForSignal(stop, signalAbort.signal);
    const result = await Promise.race([signalTask.then(() => undefined), failed]);
    if (result) throw result;
  } finally {
    closing = true;
    signalAbort.abort();
    cancelReload?.();
    await reloadTask;
    try { await running?.stop(); } finally { await lock.release(); }
  }
}

function emptyPeerConfig(): PeerConfig {
  return { peers: [] };
}

function requireConfig(config: KeposConfig | undefined): PeerConfig {
  if (!config) throw new Error("peer vpn requires a config.toml");
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
