import b4a from "b4a";

const keyHexPattern = /^[0-9a-f]{64}$/;
const peerLabelMaximumBytes = 128;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseKeyHex(value: unknown, field: string): string {
  if (typeof value !== "string" || !keyHexPattern.test(value)) {
    throw new Error(`${field} must be 32 bytes of lowercase hex`);
  }
  return value;
}

function rejectUnknownFields(
  value: Record<string, unknown>,
  allowedFields: readonly string[],
  subject: string,
): void {
  const unknownField = Object.keys(value).find(
    (field) => !allowedFields.includes(field),
  );
  if (unknownField) throw new Error(`${subject} has unknown field: ${unknownField}`);
}

export type PeerConnectionDirection = "dial" | "accept";

export interface PeerDefinition {
  label: string;
  publicKey: string;
  connection: PeerConnectionDirection;
}

export interface PeerNetworkConfig {
  bootstrap?: import("./mux/hyperdht.js").DhtAddress[];
  route?: import("./mux/route.js").Route;
}

export interface PeerVpnConfig {
  address: string;
  peers: Array<{ peer: string; address: string; allowTcp: "all" | number[] }>;
}

export interface PeerConfig {
  vpn?: PeerVpnConfig;
  network?: PeerNetworkConfig;
  peers: PeerDefinition[];
}

function parsePeerReference(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) {
    throw new Error(`${field} must be a non-empty peer label or public key`);
  }
  if (b4a.byteLength(value, "utf8") > peerLabelMaximumBytes) {
    throw new Error(`${field} exceeds ${peerLabelMaximumBytes} bytes`);
  }
  return value;
}

function parsePeerPort(value: unknown, field: string, allowZero: boolean): number {
  const minimum = allowZero ? 0 : 1;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > 65_535
  ) {
    throw new Error(`${field} must be an integer from ${minimum} through 65535`);
  }
  return value;
}

function parsePeerDefinition(value: unknown, field: string): PeerDefinition {
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  rejectUnknownFields(value, ["label", "publicKey", "connection"], field);
  const label = value.label;
  if (
    typeof label !== "string" ||
    label.length === 0 ||
    label.trim() !== label ||
    b4a.byteLength(label, "utf8") > peerLabelMaximumBytes ||
    /[\u0000-\u001f\u007f]/u.test(label)
  ) {
    throw new Error(`${field}.label must be a non-empty bounded label`);
  }
  const publicKey = parseKeyHex(value.publicKey, `${field}.publicKey`);
  if (value.connection !== "dial" && value.connection !== "accept") {
    throw new Error(`${field}.connection must be dial or accept`);
  }
  return { label, publicKey, connection: value.connection };
}

function resolvePeerReference(
  reference: string,
  peers: readonly PeerDefinition[],
  field: string,
): void {
  if (keyHexPattern.test(reference)) {
    if (!peers.some(({ publicKey }) => publicKey === reference)) {
      throw new Error(`${field} references an unknown peer public key`);
    }
    return;
  }
  if (!peers.some(({ label }) => label === reference)) {
    throw new Error(`${field} references an unknown peer label`);
  }
}

/** Parse the strict peer-oriented in-memory configuration shape. */
export function parsePeerConfig(value: unknown): PeerConfig {
  if (!isRecord(value)) throw new Error("peer config must be an object");
  rejectUnknownFields(
    value,
    ["network", "vpn", "peers"],
    "peer config",
  );
  if (!Array.isArray(value.peers)) throw new Error("peers must be an array");
  const peers = value.peers.map((entry, index) => parsePeerDefinition(entry, `peers[${index}]`));
  const labels = new Set<string>();
  const publicKeys = new Set<string>();
  for (const peer of peers) {
    if (labels.has(peer.label)) throw new Error(`duplicate peer label: ${peer.label}`);
    if (publicKeys.has(peer.publicKey)) throw new Error(`duplicate peer public key: ${peer.publicKey}`);
    labels.add(peer.label);
    publicKeys.add(peer.publicKey);
  }
  return {
    ...(value.vpn === undefined ? {} : { vpn: parsePeerVpn(value.vpn, peers) }),
    ...(value.network === undefined ? {} : { network: parsePeerNetwork(value.network) }),
    peers,
  };
}

function parseVpnAddress(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} must be a unicast IPv4 address`);
  const parts = value.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^(0|[1-9][0-9]{0,2})$/.test(part) || Number(part) > 255)) {
    throw new Error(`${field} must be a unicast IPv4 address`);
  }
  const first = Number(parts[0]);
  if (first === 0 || first === 127 || first >= 224 || (first === 169 && Number(parts[1]) === 254)) {
    throw new Error(`${field} must be a unicast IPv4 address`);
  }
  return value;
}

function parsePeerVpn(value: unknown, peers: readonly PeerDefinition[]): PeerVpnConfig {
  if (!isRecord(value)) throw new Error("vpn must be an object");
  rejectUnknownFields(value, ["address", "peers"], "vpn");
  const address = parseVpnAddress(value.address, "vpn.address");
  if (!Array.isArray(value.peers)) throw new Error("vpn.peers must be an array");
  if (value.peers.length > 16) throw new Error("vpn supports at most 16 peers");
  const addresses = new Set([address]);
  const keys = new Set<string>();
  const entries = value.peers.map((item, index) => {
    const field = `vpn.peers[${index}]`;
    if (!isRecord(item)) throw new Error(`${field} must be an object`);
    rejectUnknownFields(item, ["peer", "address", "allowTcp"], field);
    const peer = parsePeerReference(item.peer, `${field}.peer`);
    resolvePeerReference(peer, peers, `${field}.peer`);
    const key = keyHexPattern.test(peer) ? peer : peers.find((entry) => entry.label === peer)!.publicKey;
    if (keys.has(key)) throw new Error(`${field} duplicates a VPN peer`);
    keys.add(key);
    const peerAddress = parseVpnAddress(item.address, `${field}.address`);
    if (addresses.has(peerAddress)) throw new Error(`${field} duplicates a VPN address`);
    addresses.add(peerAddress);
    let allowTcp: "all" | number[] = [];
    if (item.allowTcp === "all") allowTcp = "all";
    else if (item.allowTcp !== undefined) {
      if (!Array.isArray(item.allowTcp)) throw new Error(`${field}.allowTcp must be all or an array of TCP ports`);
      allowTcp = item.allowTcp.map((port, i) => parsePeerPort(port, `${field}.allowTcp[${i}]`, false));
      if (new Set(allowTcp).size !== allowTcp.length) throw new Error(`${field}.allowTcp contains a duplicate port`);
    }
    return { peer, address: peerAddress, allowTcp };
  });
  return { address, peers: entries };
}

function parsePeerNetwork(value: unknown): PeerNetworkConfig {
  if (!isRecord(value)) throw new Error("network must be an object");
  rejectUnknownFields(value, ["bootstrap", "route"], "network");
  let bootstrap: import("./mux/hyperdht.js").DhtAddress[] | undefined;
  if (value.bootstrap !== undefined) {
    if (!Array.isArray(value.bootstrap)) throw new Error("network.bootstrap must be an array");
    bootstrap = value.bootstrap.map((entry, index) => {
      if (!isRecord(entry)) throw new Error(`network.bootstrap[${index}] must be an object`);
      rejectUnknownFields(entry, ["host", "port"], `network.bootstrap[${index}]`);
      if (typeof entry.host !== "string" || entry.host.length === 0) {
        throw new Error(`network.bootstrap[${index}].host must be non-empty`);
      }
      return { host: entry.host, port: parsePeerPort(entry.port, `network.bootstrap[${index}].port`, false) };
    });
    if (bootstrap.length === 0) bootstrap = undefined;
  }
  return {
    ...(bootstrap ? { bootstrap } : {}),
    ...(value.route === undefined ? {} : { route: parsePeerRoute(value.route) }),
  };
}

function parsePeerRoute(value: unknown): import("./mux/route.js").Route {
  if (value !== "auto" && value !== "public") throw new Error("network.route must be auto or public");
  return value;
}
