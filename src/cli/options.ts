import type { DhtAddress } from "../mux/hyperdht.js";

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
