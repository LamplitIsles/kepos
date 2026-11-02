import { parse, stringify } from "smol-toml";
import { parsePeerConfig, type PeerConfig, type PeerNetworkConfig } from "./config.js";
import { parseBootstrapValues } from "./cli/options.js";
import { parseRoute } from "./mux/route.js";

type KeposConfig = PeerConfig;

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
