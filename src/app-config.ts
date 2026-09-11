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
  type PeerBinding,
  type PeerConfig,
  type PeerGatewayConfig,
  type PeerNetworkConfig,
  type PeerService,
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

export async function loadKeposBootstrap(
  configPath?: string,
  environment?: NodeJS.ProcessEnv,
  homeDirectory?: string,
  platform?: NodeJS.Platform,
): Promise<PeerNetworkConfig["bootstrap"] | undefined> {
  const config = await loadKeposConfig(
    configPath,
    environment,
    homeDirectory,
    platform,
  );
  return config?.network?.bootstrap;
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
    "gateway",
    "peers",
    "services",
    "bindings",
  ]);
  if (!Array.isArray(root.peers)) throw new Error("peers must be an array");
  if (!Array.isArray(root.services)) throw new Error("services must be an array");
  if (!Array.isArray(root.bindings)) throw new Error("bindings must be an array");

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
  const rawServices = root.services.map((value, index) => {
    const service = requireTable(value, `services[${index}]`);
    rejectUnknownFields(service, `services[${index}]`, [
      "id",
      "name",
      "kind",
      "source",
      "allow",
      "max_publisher_to_subscriber_bps",
    ]);
    return {
      id: service.id,
      name: service.name,
      ...(service.kind === undefined ? {} : { kind: service.kind }),
      source: parseTomlSource(service.source, `services[${index}].source`),
      ...(service.allow === undefined ? {} : { allow: service.allow }),
      ...(service.max_publisher_to_subscriber_bps === undefined
        ? {}
        : {
            maxPublisherToSubscriberBps:
              service.max_publisher_to_subscriber_bps,
          }),
    };
  });
  const rawBindings = root.bindings.map((value, index) => {
    const binding = requireTable(value, `bindings[${index}]`);
    rejectUnknownFields(binding, `bindings[${index}]`, [
      "peer",
      "service",
      "listen",
    ]);
    return {
      peer: binding.peer,
      service: binding.service,
      listen: parseTomlListen(binding.listen, `bindings[${index}].listen`),
    };
  });

  return parsePeerConfig({
    ...(root.network === undefined
      ? {}
      : { network: parseTomlNetwork(root.network) }),
    ...(root.gateway === undefined
      ? {}
      : { gateway: parseTomlGateway(root.gateway) }),
    peers: rawPeers,
    services: rawServices,
    bindings: rawBindings,
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
    services: parsed.services.map(serializeService),
    bindings: parsed.bindings.map(({ peer, service, listen }) => ({
      peer,
      service,
      listen: serializeListen(listen),
    })),
  };
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
  if (parsed.gateway) {
    value.gateway = {
      ...(parsed.gateway.port === undefined ? {} : { port: parsed.gateway.port }),
      ...(parsed.gateway.host === undefined ? {} : { host: parsed.gateway.host }),
      ...(parsed.gateway.domain === undefined
        ? {}
        : { domain: parsed.gateway.domain }),
    };
  }
  const source = stringify(value);
  parseKeposConfig(source);
  return source;
}

function serializeService(service: PeerService): Record<string, unknown> {
  return {
    id: service.id,
    name: service.name,
    ...(service.kind === "tcp" ? {} : { kind: service.kind }),
    source: serializeSource(service.source),
    ...(service.allow.length === 0 ? {} : { allow: service.allow }),
    ...(service.maxPublisherToSubscriberBps === undefined
      ? {}
      : {
          max_publisher_to_subscriber_bps:
            service.maxPublisherToSubscriberBps,
        }),
  };
}

function serializeSource(source: PeerService["source"]): Record<string, unknown> {
  if ("localPort" in source) return { local_port: source.localPort };
  if ("unixSocket" in source) return { unix_socket: source.unixSocket };
  return { peer: source.peer, service: source.service };
}

function serializeListen(
  listen: PeerBinding["listen"],
): Record<string, unknown> {
  return "localPort" in listen
    ? { local_port: listen.localPort }
    : { unix_socket: listen.unixSocket };
}

function parseTomlSource(value: unknown, field: string): PeerService["source"] {
  const source = requireTable(value, field);
  rejectUnknownFields(source, field, [
    "local_port",
    "unix_socket",
    "peer",
    "service",
  ]);
  const raw: Record<string, unknown> = {};
  if (Object.prototype.hasOwnProperty.call(source, "local_port")) {
    raw.localPort = source.local_port;
  }
  if (Object.prototype.hasOwnProperty.call(source, "unix_socket")) {
    raw.unixSocket = source.unix_socket;
  }
  if (Object.prototype.hasOwnProperty.call(source, "peer")) raw.peer = source.peer;
  if (Object.prototype.hasOwnProperty.call(source, "service")) {
    raw.service = source.service;
  }
  return raw as unknown as PeerService["source"];
}

function parseTomlListen(value: unknown, field: string): PeerBinding["listen"] {
  const listen = requireTable(value, field);
  rejectUnknownFields(listen, field, ["local_port", "unix_socket"]);
  const raw: Record<string, unknown> = {};
  if (Object.prototype.hasOwnProperty.call(listen, "local_port")) {
    raw.localPort = listen.local_port;
  }
  if (Object.prototype.hasOwnProperty.call(listen, "unix_socket")) {
    raw.unixSocket = listen.unix_socket;
  }
  return raw as unknown as PeerBinding["listen"];
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

function parseTomlGateway(value: unknown): PeerGatewayConfig {
  const gateway = requireTable(value, "gateway");
  rejectUnknownFields(gateway, "gateway", ["port", "host", "domain"]);
  return {
    ...(gateway.port === undefined ? {} : { port: gateway.port as number }),
    ...(gateway.host === undefined ? {} : { host: gateway.host as string }),
    ...(gateway.domain === undefined ? {} : { domain: gateway.domain as string }),
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
