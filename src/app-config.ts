import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { parse, stringify } from "smol-toml";

import {
  parsePeerConfig,
  type PeerConfig,
  type PeerNetworkConfig,
} from "./config.js";
import { parseBootstrapValues } from "./cli/options.js";
import { parseRoute } from "./mux/route.js";
import { defaultKeposConfigPath } from "./platform/paths.js";
import { replaceFileAtomically } from "./state/files.js";

/** The one canonical configuration type read by every repository-owned host. */
export type KeposConfig = PeerConfig;

export async function loadKeposConfig(
  configPath?: string,
  environment?: NodeJS.ProcessEnv,
  homeDirectory?: string,
  platform?: NodeJS.Platform,
): Promise<KeposConfig | undefined> {
  const source = await readKeposConfigSource(
    configPath,
    environment,
    homeDirectory,
    platform,
  );
  return source === undefined ? undefined : parseKeposConfig(source);
}

async function readKeposConfigSource(
  configPath: string | undefined,
  environment: NodeJS.ProcessEnv | undefined,
  homeDirectory: string | undefined,
  platform?: NodeJS.Platform,
): Promise<string | undefined> {
  const resolvedPath =
    configPath ?? defaultKeposConfigPath(environment, homeDirectory, platform);
  try {
    return await readFile(resolvedPath, "utf8");
  } catch (error) {
    if (
      configPath === undefined &&
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return undefined;
    }
    throw new Error(`Cannot read Kepos config: ${resolvedPath}`, {
      cause: error,
    });
  }
}

/** Parse the strict snake_case TOML representation of a peer config. */
export function parseKeposConfig(source: string): KeposConfig {
  const value: unknown = parse(source);
  const root = requireTable(value, "config");
  rejectUnknownFields(root, "config", [
    "network",
    "vpn",
    "peers",
  ]);
  if (!Array.isArray(root.peers)) throw new Error("peers must be an array");

  const rawPeers = root.peers.map((value, index) => {
    const peer = requireTable(value, `peers[${index}]`);
    rejectUnknownFields(peer, `peers[${index}]`, [
      "label",
      "public_key",
      "connection",
    ]);
    return {
      label: peer.label,
      publicKey: peer.public_key,
      connection: peer.connection,
    };
  });
  return parsePeerConfig({
    ...(root.vpn === undefined ? {} : { vpn: parseTomlVpn(root.vpn) }),
    ...(root.network === undefined
      ? {}
      : { network: parseTomlNetwork(root.network) }),
    peers: rawPeers,
  });
}

export function serializeKeposConfig(config: KeposConfig): string {
  const parsed = parsePeerConfig(config);
  const value: Record<string, unknown> = {
    peers: parsed.peers.map(({ label, publicKey, connection }) => ({
      label,
      public_key: publicKey,
      connection,
    })),
  };
  if (parsed.vpn) {
    value.vpn = {
      address: parsed.vpn.address,
      peers: parsed.vpn.peers.map(({ peer, address, allowTcp }) => ({ peer, address, allow_tcp: allowTcp })),
    };
  }
  if (parsed.network) {
    value.network = {
      ...(parsed.network.bootstrap
        ? {
            bootstrap: parsed.network.bootstrap.map(
              ({ host, port }) => `${host}:${port}`,
            ),
          }
        : {}),
      ...(parsed.network.route === undefined
        ? {}
        : { route: parsed.network.route }),
    };
  }
  const source = stringify(value);
  parseKeposConfig(source);
  return source;
}

function parseTomlVpn(value: unknown): unknown {
  const vpn = requireTable(value, "vpn");
  rejectUnknownFields(vpn, "vpn", ["address", "peers"]);
  if (!Array.isArray(vpn.peers)) throw new Error("vpn.peers must be an array");
  return {
    address: vpn.address,
    peers: vpn.peers.map((value, index) => {
      const field = `vpn.peers[${index}]`;
      const peer = requireTable(value, field);
      rejectUnknownFields(peer, field, ["peer", "address", "allow_tcp"]);
      return { peer: peer.peer, address: peer.address, allowTcp: peer.allow_tcp };
    }),
  };
}

function parseTomlNetwork(value: unknown): PeerNetworkConfig {
  const network = requireTable(value, "network");
  rejectUnknownFields(network, "network", ["bootstrap", "route"]);
  let bootstrap: PeerNetworkConfig["bootstrap"];
  if (network.bootstrap !== undefined) {
    if (
      !Array.isArray(network.bootstrap) ||
      !network.bootstrap.every((entry) => typeof entry === "string")
    ) {
      throw new Error("network.bootstrap must be an array of host:port strings");
    }
    bootstrap = parseBootstrapValues(network.bootstrap, "network.bootstrap");
  }
  return {
    ...(bootstrap && bootstrap.length > 0 ? { bootstrap } : {}),
    ...(network.route === undefined
      ? {}
      : { route: parseRoute(String(network.route)) }),
  };
}

function requireTable(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be a TOML table`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownFields(
  value: Record<string, unknown>,
  field: string,
  allowed: readonly string[],
): void {
  const unknown = Object.keys(value).find((name) => !allowed.includes(name));
  if (unknown) throw new Error(`${field} has unknown field: ${unknown}`);
}

export async function saveKeposConfig(
  config: KeposConfig,
  configPath = defaultKeposConfigPath(),
): Promise<void> {
  const source = serializeKeposConfig(config);
  const directory = path.dirname(configPath);
  await mkdir(directory, { mode: 0o700, recursive: true });
  const temporaryDirectory = await mkdtemp(path.join(directory, ".config-"));
  const temporaryPath = path.join(temporaryDirectory, "config.toml");
  try {
    await writeFile(temporaryPath, source, { flag: "wx", mode: 0o600 });
    await replaceFileAtomically(temporaryPath, configPath);
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
}
