import path from "node:path";

import type { DhtAddress } from "../mux/hyperdht.js";
import { parseRoute, type Route } from "../mux/route.js";
import {
  parseGatewayDomain,
  parseGatewayHost,
} from "../home/gateway-options.js";
import type { MetricsListenAddress } from "../metrics/server.js";

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

export function requiredOption(
  options: ParsedOptions,
  name: string,
): string {
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

export function repeatedOption(
  options: ParsedOptions,
  name: string,
): string[] {
  return [...(options.get(name) ?? [])];
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

export function parseMetricsListenOption(
  options: ParsedOptions,
): MetricsListenAddress | undefined {
  const value = singleOption(options, "--metrics-listen");
  if (value === undefined) return undefined;
  return parseMetricsListenValue(value);
}

export function parseMetricsListenValue(value: string): MetricsListenAddress {
  let host: string;
  let portText: string;
  if (value.startsWith("[")) {
    const closing = value.indexOf("]:");
    if (closing < 0) throw new Error("--metrics-listen must use host:port");
    host = value.slice(1, closing);
    portText = value.slice(closing + 2);
  } else {
    const separator = value.lastIndexOf(":");
    if (separator <= 0) throw new Error("--metrics-listen must use host:port");
    host = value.slice(0, separator);
    portText = value.slice(separator + 1);
    if (host.includes(":")) {
      throw new Error("IPv6 metrics hosts must be enclosed in brackets");
    }
  }
  if (!host || !portText) throw new Error("--metrics-listen must use host:port");
  return { host, port: parseTcpPort(portText, "--metrics-listen", true) };
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

export function observationMode(
  options: ParsedOptions,
): "human" | "ndjson" {
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
