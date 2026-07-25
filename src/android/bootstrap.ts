import type { DhtAddress } from "../mux/hyperdht.js";

export function parseAndroidBootstrapAsset(
  source: string,
): DhtAddress[] | undefined {
  const value: unknown = JSON.parse(source);
  if (value === null) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("invalid Android bootstrap asset");
  }
  const endpoints = value.map((endpoint) => {
    if (
      typeof endpoint !== "object" ||
      endpoint === null ||
      !("host" in endpoint) ||
      typeof endpoint.host !== "string" ||
      endpoint.host.length === 0 ||
      !("port" in endpoint) ||
      !Number.isInteger(endpoint.port) ||
      (endpoint.port as number) < 1 ||
      (endpoint.port as number) > 65_535
    ) {
      throw new Error("invalid Android bootstrap asset");
    }
    return { host: endpoint.host, port: endpoint.port as number };
  });
  return endpoints;
}
