import type { DhtAddress } from "./mux/hyperdht.js";

export function parseBootstrapAsset(
  source: string,
): DhtAddress[] | undefined {
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    throw new Error("invalid Kepos bootstrap asset");
  }
  if (value === null) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("invalid Kepos bootstrap asset");
  }
  return value.map((endpoint) => {
    if (
      endpoint === null ||
      typeof endpoint !== "object" ||
      Object.keys(endpoint).length !== 2 ||
      !("host" in endpoint) ||
      typeof endpoint.host !== "string" ||
      endpoint.host.length === 0 ||
      !("port" in endpoint) ||
      !Number.isInteger(endpoint.port) ||
      endpoint.port < 1 ||
      endpoint.port > 65_535
    ) {
      throw new Error("invalid Kepos bootstrap asset");
    }
    return { host: endpoint.host, port: endpoint.port };
  });
}

export function requireBootstrapAsset(
  bootstrap: DhtAddress[] | undefined,
): DhtAddress[] {
  if (bootstrap === undefined || bootstrap.length === 0) {
    throw new Error("required Kepos bootstrap asset is empty");
  }
  return bootstrap;
}
