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
  parsePublisherConfig,
  parsePublisherManifest,
} from "./config.js";
import type { DhtAddress } from "./mux/hyperdht.js";
import { parseRoute, type Route } from "./mux/route.js";
import {
  parseGatewayDomain,
  parseGatewayHost,
} from "./home/gateway-options.js";
import type { PublisherRuntimePolicy } from "./runtime/publisher.js";
import type { SubscriberService } from "./runtime/subscriber.js";
import {
  parseBootstrapValues,
  parseSubscriberService,
} from "./cli/options.js";
import { defaultKeposConfigPath } from "./platform/paths.js";
import { replaceFileAtomically } from "./state/files.js";

export interface KeposConfig {
  network?: {
    bootstrap?: DhtAddress[];
  };
  publisher?: PublisherRuntimePolicy & { enabled?: boolean };
  subscriber?: {
    enabled?: boolean;
    gatewayPort?: number;
    gatewayHost?: string;
    gatewayDomain?: string;
    route?: Route;
    services?: SubscriberService[];
  };
}

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
): Promise<DhtAddress[] | undefined> {
  const source = await readKeposConfigSource(
    configPath,
    environment,
    homeDirectory,
    platform,
  );
  if (source === undefined) return undefined;
  const value: unknown = parse(source);
  const root = requireTable(value, "config");
  if (root.network === undefined) return undefined;
  return parseNetwork(root.network).bootstrap;
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

export function parseKeposConfig(source: string): KeposConfig {
  const value: unknown = parse(source);
  const root = requireTable(value, "config");
  rejectUnknownFields(root, [], ["network", "publisher", "subscriber"]);

  const config: KeposConfig = {};
  if (root.network !== undefined) config.network = parseNetwork(root.network);
  if (root.publisher !== undefined) {
    config.publisher = parsePublisher(root.publisher);
  }
  if (root.subscriber !== undefined) {
    config.subscriber = parseSubscriber(root.subscriber);
  }
  return config;
}

export function serializeKeposConfig(config: KeposConfig): string {
  const value: Record<string, unknown> = {};
  if (config.network) {
    value.network = {
      ...(config.network.bootstrap
        ? {
            bootstrap: config.network.bootstrap.map(
              ({ host, port }) => `${host}:${port}`,
            ),
          }
        : {}),
    };
  }
  if (config.publisher) {
    value.publisher = {
      ...(config.publisher.enabled === undefined
        ? {}
        : { enabled: config.publisher.enabled }),
      display_name: config.publisher.displayName,
      allow: config.publisher.allow,
      services: config.publisher.services.map(
        ({ id, name, targetPort, allow }) => ({
          id,
          name,
          target_port: targetPort,
          ...(allow === undefined ? {} : { allow }),
        }),
      ),
    };
  }
  if (config.subscriber) {
    value.subscriber = {
      ...(config.subscriber.enabled === undefined
        ? {}
        : { enabled: config.subscriber.enabled }),
      ...(config.subscriber.gatewayPort === undefined
        ? {}
        : { gateway_port: config.subscriber.gatewayPort }),
      ...(config.subscriber.gatewayHost === undefined
        ? {}
        : { gateway_host: config.subscriber.gatewayHost }),
      ...(config.subscriber.gatewayDomain === undefined
        ? {}
        : { gateway_domain: config.subscriber.gatewayDomain }),
      ...(config.subscriber.route === undefined
        ? {}
        : { route: config.subscriber.route }),
      ...(config.subscriber.services === undefined
        ? {}
        : {
            services: config.subscriber.services.map(({ id, localPort }) => ({
              id,
              local_port: localPort,
            })),
          }),
    };
  }
  const source = stringify(value);
  parseKeposConfig(source);
  return source;
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

function parseNetwork(value: unknown): NonNullable<KeposConfig["network"]> {
  const network = requireTable(value, "network");
  rejectUnknownFields(network, ["network"], ["bootstrap"]);
  if (network.bootstrap === undefined) return {};
  if (
    !Array.isArray(network.bootstrap) ||
    !network.bootstrap.every((endpoint) => typeof endpoint === "string")
  ) {
    throw new Error("network.bootstrap must be an array of host:port strings");
  }
  if (network.bootstrap.length === 0) return {};
  return {
    bootstrap: parseBootstrapValues(network.bootstrap, "network.bootstrap"),
  };
}

function parsePublisher(value: unknown): PublisherRuntimePolicy {
  const publisher = requireTable(value, "publisher");
  rejectUnknownFields(
    publisher,
    ["publisher"],
    ["enabled", "display_name", "allow", "services"],
  );
  if (!Array.isArray(publisher.allow)) {
    throw new Error("publisher.allow must be an array");
  }
  if (!Array.isArray(publisher.services)) {
    throw new Error("publisher.services must be an array");
  }

  const services = publisher.services.map((value, index) => {
    const service = requireTable(value, `publisher.services[${index}]`);
    rejectUnknownFields(
      service,
      ["publisher", `services[${index}]`],
      ["id", "name", "target_port", "allow"],
    );
    return {
      id: service.id,
      name: service.name,
      kind: "tcp",
      targetPort: service.target_port,
      ...(service.allow === undefined ? {} : { allow: service.allow }),
    };
  });
  const manifest = parsePublisherManifest({
    displayName: publisher.display_name,
    publisherConfig: "publisher.json",
    services,
  });
  const allow = parsePublisherConfig({
    seed: "00".repeat(32),
    allow: publisher.allow,
  }).allow;
  return {
    ...(publisher.enabled === undefined
      ? {}
      : { enabled: parseBoolean(publisher.enabled, "publisher.enabled") }),
    displayName: manifest.displayName,
    allow,
    services: manifest.services.map(({ id, name, targetPort, allow }) => ({
      id,
      name,
      targetPort,
      ...(allow === undefined ? {} : { allow }),
    })),
  };
}

function parseSubscriber(
  value: unknown,
): NonNullable<KeposConfig["subscriber"]> {
  const subscriber = requireTable(value, "subscriber");
  rejectUnknownFields(
    subscriber,
    ["subscriber"],
    [
      "enabled",
      "gateway_port",
      "gateway_host",
      "gateway_domain",
      "route",
      "services",
    ],
  );
  const config: NonNullable<KeposConfig["subscriber"]> = {};
  if (subscriber.enabled !== undefined) {
    config.enabled = parseBoolean(subscriber.enabled, "subscriber.enabled");
  }
  if (subscriber.gateway_port !== undefined) {
    config.gatewayPort = parsePort(
      subscriber.gateway_port,
      "subscriber.gateway_port",
    );
  }
  if (subscriber.gateway_host !== undefined) {
    if (typeof subscriber.gateway_host !== "string") {
      throw new Error("subscriber.gateway_host must be a string");
    }
    config.gatewayHost = parseGatewayHost(
      subscriber.gateway_host,
      "subscriber.gateway_host",
    );
  }
  if (subscriber.gateway_domain !== undefined) {
    if (typeof subscriber.gateway_domain !== "string") {
      throw new Error("subscriber.gateway_domain must be a string");
    }
    config.gatewayDomain = parseGatewayDomain(
      subscriber.gateway_domain,
      "subscriber.gateway_domain",
    );
  }
  if (subscriber.route !== undefined) {
    if (typeof subscriber.route !== "string") {
      throw new Error("subscriber.route must be auto or public");
    }
    config.route = parseRoute(subscriber.route);
  }
  if (subscriber.services !== undefined) {
    if (!Array.isArray(subscriber.services)) {
      throw new Error("subscriber.services must be an array");
    }
    config.services = subscriber.services.map((value, index) => {
      const service = requireTable(value, `subscriber.services[${index}]`);
      rejectUnknownFields(
        service,
        ["subscriber", `services[${index}]`],
        ["id", "local_port"],
      );
      if (typeof service.id !== "string") {
        throw new Error(`subscriber.services[${index}].id must be a string`);
      }
      const localPort = parsePort(
        service.local_port,
        `subscriber.services[${index}].local_port`,
        true,
      );
      return parseSubscriberService(`${service.id}:${localPort}`);
    });
    if (
      new Set(config.services.map(({ id }) => id)).size !==
      config.services.length
    ) {
      throw new Error("subscriber services must have unique ids");
    }
  }
  return config;
}

function parseBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${field} must be true or false`);
  }
  return value;
}

function parsePort(value: unknown, field: string, allowZero = false): number {
  const minimum = allowZero ? 0 : 1;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > 65_535
  ) {
    throw new Error(
      `${field} must be an integer from ${minimum} through 65535`,
    );
  }
  return value;
}

function requireTable(
  value: unknown,
  name: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be a TOML table`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownFields(
  value: Record<string, unknown>,
  pathParts: string[],
  allowed: readonly string[],
): void {
  const allowedFields = new Set(allowed);
  const unknown = Object.keys(value).find((field) => !allowedFields.has(field));
  if (!unknown) return;
  throw new Error(`unknown field: ${[...pathParts, unknown].join(".")}`);
}
