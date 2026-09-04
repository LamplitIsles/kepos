import path from "node:path";

import type { DhtAddress } from "../mux/hyperdht.js";
import { parseRoute, type Route } from "../mux/route.js";
import type { MetricsListenAddress } from "../metrics/server.js";
import type { SubscriberService } from "../runtime/subscriber.js";
import {
  parseGatewayDomain,
  parseGatewayHost,
} from "../home/gateway-options.js";

export type ParsedOptions = ReadonlyMap<string, readonly string[]>;

export function parseOptions(
  arguments_: readonly string[],
  allowed: readonly string[],
): ParsedOptions {
  const allowedSet = new Set(allowed);
  const parsed = new Map<string, string[]>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const option = arguments_[index] ?? "";
    if (!allowedSet.has(option)) {
      throw new Error(`unknown option: ${option}`);
    }
    const value = arguments_[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${option} requires a value`);
    }
    const values = parsed.get(option) ?? [];
    values.push(value);
    parsed.set(option, values);
  }
  return parsed;
}

export function requiredState(options: ParsedOptions): string {
  const state = singleOption(options, "--state");
  if (!state) throw new Error("--state is required");
  return path.resolve(state);
}

export function requiredOption(options: ParsedOptions, name: string): string {
  const value = singleOption(options, name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function singleOption(
  options: ParsedOptions,
  name: string,
): string | undefined {
  const values = options.get(name);
  if (!values || values.length === 0) return undefined;
  if (values.length > 1) throw new Error(`${name} may be used only once`);
  return values[0];
}

export function repeatedOption(options: ParsedOptions, name: string): string[] {
  return [...(options.get(name) ?? [])];
}

export function parseMetricsListenOption(
  options: ParsedOptions,
): MetricsListenAddress | undefined {
  const value = singleOption(options, "--metrics-listen");
  if (value === undefined) return undefined;
  const separator = value.startsWith("[")
    ? value.indexOf("]:") + 1
    : value.lastIndexOf(":");
  if (separator <= 0 || separator >= value.length - 1) {
    throw new Error("--metrics-listen must use host:port");
  }
  const host = value.startsWith("[")
    ? value.slice(1, separator - 1)
    : value.slice(0, separator);
  const port = value.slice(separator + 1);
  if (!host) throw new Error("--metrics-listen host must be non-empty");
  return {
    host,
    port: parseTcpPort(port, "--metrics-listen port", true),
  };
}

export function parseSubscriberService(value: string): SubscriberService {
  const [id, port, ...extra] = value.split(":");
  if (!id || !port || extra.length > 0) {
    throw new Error("--service must use id:local-port");
  }
  if (!/^[a-z][a-z0-9-]*$/.test(id) || id === "home") {
    throw new Error("--service id must be a non-reserved lowercase identifier");
  }
  return {
    id,
    localPort: parseTcpPort(port, "--service local port", true),
  };
}

export function parseRouteOption(options: ParsedOptions): Route {
  return parseRoute(singleOption(options, "--route") ?? "auto");
}

export function parseGatewayPortOption(
  options: ParsedOptions,
): number | undefined {
  const value = singleOption(options, "--gateway-port");
  return value === undefined
    ? undefined
    : parseTcpPort(value, "--gateway-port");
}

export function parseGatewayHostOption(
  options: ParsedOptions,
): string | undefined {
  const value = singleOption(options, "--gateway-host");
  return value === undefined
    ? undefined
    : parseGatewayHost(value, "--gateway-host");
}

export function parseGatewayDomainOption(
  options: ParsedOptions,
): string | undefined {
  const value = singleOption(options, "--gateway-domain");
  return value === undefined
    ? undefined
    : parseGatewayDomain(value, "--gateway-domain");
}

export function parseBootstrapOptions(
  options: ParsedOptions,
): DhtAddress[] | undefined {
  const values = repeatedOption(options, "--bootstrap");
  if (values.length === 0) return undefined;
  return parseBootstrapValues(values, "--bootstrap");
}

export function parseBootstrapValues(
  values: readonly string[],
  label: string,
): DhtAddress[] {
  return values.map((value) => {
    const [host, port, ...extra] = value.split(":");
    if (!host || !port || extra.length > 0) {
      throw new Error(`${label} must use host:port`);
    }
    return {
      host,
      port: parseTcpPort(port, `${label} port`),
    };
  });
}

export function observationMode(options: ParsedOptions): "human" | "ndjson" {
  const mode = singleOption(options, "--observations") ?? "human";
  if (mode === "human" || mode === "ndjson") return mode;
  throw new Error("--observations must be human or ndjson");
}

function parseTcpPort(
  value: string,
  option: string,
  allowZero = false,
): number {
  const port = Number(value);
  const minimum = allowZero ? 0 : 1;
  if (!Number.isInteger(port) || port < minimum || port > 65_535) {
    throw new Error(
      `${option} must be an integer from ${minimum} through 65535`,
    );
  }
  return port;
}
