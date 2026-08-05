import b4a from "b4a";
import HyperDhtModule from "hyperdht";
import { Duplex } from "node:stream";

import { sanitizeObservation } from "./observability.js";

const HyperDHT = HyperDhtModule as HyperDhtConstructor;

export interface DhtAddress {
  host: string;
  port: number;
}

export type DhtHolepunch = (
  remoteFirewall: number,
  localFirewall: number,
  remoteAddresses: DhtAddress[],
  localAddresses: DhtAddress[],
) => boolean;

interface DhtStats {
  punches: {
    consistent: number;
    random: number;
    open: number;
  };
  relaying: {
    attempts: number;
    successes: number;
    aborts: number;
  };
  relayStatus?:
    | "relay_unconfigured"
    | "relay_configured"
    | "relay_attempt_seen"
    | "relay_active_seen"
    | "relay_abort_seen";
  sockets?: {
    candidateListener?: DhtSocketObservation;
    control?: DhtSocketObservation;
  };
}

interface DhtSocketObservation {
  socketClass: "dht_candidate_listener" | "dht_client";
  localPort: number;
}

export interface DhtKeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

export interface DhtStream extends Duplex {
  connected?: boolean;
  rawStream?: unknown;
  remotePublicKey: Buffer;
  setKeepAlive?: (intervalMs: number) => void;
  toJSON?: () => unknown;
}

export interface DhtServer {
  close: () => Promise<void>;
  listen: (keyPair: DhtKeyPair) => Promise<void>;
}

export interface DhtNode {
  connect: (
    publicKey: Uint8Array,
    options: {
      keyPair: DhtKeyPair;
      localConnection: boolean;
      reusableSocket: true;
      holepunch?: DhtHolepunch;
    },
  ) => DhtStream;
  createServer: (
    options: {
      firewall: (remotePublicKey: Uint8Array) => boolean;
      reusableSocket: true;
    },
    onConnection: (stream: DhtStream) => void,
  ) => DhtServer;
  stats: DhtStats;
  address?: () => DhtAddress | null;
  localAddress?: () => DhtAddress | null;
  destroy: (options?: { force?: boolean }) => Promise<void>;
}

interface HyperDhtConstructor {
  new (options: {
    bootstrap?: DhtAddress[];
    connectionKeepAlive: number;
    keyPair?: DhtKeyPair;
  }): DhtNode;
  keyPair: (seed?: Uint8Array) => DhtKeyPair;
}

export function createDht(options: {
  bootstrap?: DhtAddress[];
  keyPair?: DhtKeyPair;
}): DhtNode {
  return new HyperDHT({
    ...options,
    connectionKeepAlive: 10_000,
  });
}

export function keyPairFromSeed(seed: string): DhtKeyPair {
  return HyperDHT.keyPair(b4a.from(seed, "hex"));
}

export function keyPairFromSecretKey(secretKey: string): DhtKeyPair {
  return HyperDHT.keyPair(b4a.from(secretKey.slice(0, 64), "hex"));
}

export function dhtStreamSnapshot(stream: DhtStream): unknown {
  const snapshot = stream.toJSON?.();
  const rawSnapshot =
    snapshot !== null && typeof snapshot === "object" && !Array.isArray(snapshot)
      ? (snapshot as Record<string, unknown>)
      : {};
  const base = {
    ...booleanFields(rawSnapshot, [
      "isInitiator",
      "connected",
      "destroying",
      "destroyed",
    ]),
    ...keyFields(rawSnapshot, ["publicKey", "remotePublicKey"]),
  };
  const udx = udxStreamSnapshot(stream.rawStream);
  const path = udxPathSnapshot(stream.rawStream);

  return sanitizeObservation({
    ...base,
    ...path,
    ...(udx ? { udx } : {}),
  });
}

export function dhtFirewallName(value: number): string {
  if (value === 1) return "open";
  if (value === 2) return "consistent";
  if (value === 3) return "random";
  return "unknown";
}

export function holepunchObservation(
  remoteFirewall: number,
  localFirewall: number,
  remoteAddresses: DhtAddress[],
  localAddresses: DhtAddress[],
  options: { localConnection?: boolean } = {},
): Record<string, string | number> {
  return {
    remoteFirewall: dhtFirewallName(remoteFirewall),
    localFirewall: dhtFirewallName(localFirewall),
    remoteAddressCount: remoteAddresses.length,
    localAddressCount: localAddresses.length,
    path: "direct_punch",
    socketClass: "udx_connection",
    localCandidateSelection:
      options.localConnection === false ? "disabled" : "pending",
    localPortVisibility: "not_exposed",
    relayStatus: "relay_unconfigured",
  };
}

export function dhtStatsSnapshot(
  node: DhtNode,
  options: { relayConfigured?: boolean } = {},
): DhtStats {
  const sockets = dhtSocketObservations(node);
  return {
    punches: {
      consistent: node.stats.punches.consistent,
      random: node.stats.punches.random,
      open: node.stats.punches.open,
    },
    relaying: {
      attempts: node.stats.relaying.attempts,
      successes: node.stats.relaying.successes,
      aborts: node.stats.relaying.aborts,
    },
    relayStatus: relayStatus(
      node.stats.relaying,
      options.relayConfigured === true,
    ),
    ...(sockets ? { sockets } : {}),
  };
}

function relayStatus(
  stats: DhtStats["relaying"],
  configured: boolean,
): NonNullable<DhtStats["relayStatus"]> {
  if (stats.successes > 0) return "relay_active_seen";
  if (stats.aborts > 0) return "relay_abort_seen";
  if (stats.attempts > 0) return "relay_attempt_seen";
  return configured ? "relay_configured" : "relay_unconfigured";
}

function dhtSocketObservations(
  node: DhtNode,
): NonNullable<DhtStats["sockets"]> | undefined {
  const candidate = dhtAddress(() => node.localAddress?.());
  const control = dhtAddress(() => node.address?.());
  if (!candidate && !control) return undefined;

  const sockets: NonNullable<DhtStats["sockets"]> = {};
  if (candidate) {
    sockets.candidateListener = {
      socketClass: "dht_candidate_listener",
      localPort: candidate.port,
    };
  }
  if (control) {
    sockets.control = {
      socketClass:
        candidate?.port === control.port
          ? "dht_candidate_listener"
          : "dht_client",
      localPort: control.port,
    };
  }
  return sockets;
}

function dhtAddress(
  read: () => DhtAddress | null | undefined,
): DhtAddress | undefined {
  try {
    const address = read();
    return address && validPort(address.port) ? address : undefined;
  } catch {
    return undefined;
  }
}

function udxPathSnapshot(rawStream: unknown): Record<string, unknown> {
  if (rawStream === null || typeof rawStream !== "object") return {};

  const raw = rawStream as Record<string, unknown>;
  const remoteHost = readProperty(raw, "remoteHost");
  const localPort = udxLocalPort(readProperty(raw, "socket"));
  const path =
    typeof remoteHost === "string" && remoteHost.length > 0
      ? isPrivateAddress(remoteHost)
        ? "direct_lan"
        : "direct_public"
      : "direct_pending";

  return {
    path,
    socketClass: "udx_connection",
    ...(localPort === undefined ? {} : { localPort }),
    localCandidateSelected:
      path === "direct_lan" ? true : path === "direct_public" ? false : "unknown",
    relayStatus: "relay_unconfigured",
  };
}

function udxLocalPort(socketValue: unknown): number | undefined {
  if (socketValue === null || typeof socketValue !== "object") return undefined;
  const socket = socketValue as Record<string, unknown>;
  const address = readProperty(socket, "address");
  if (typeof address !== "function") return undefined;
  try {
    const value = address.call(socket) as unknown;
    if (value === null || typeof value !== "object") return undefined;
    const port = readProperty(value as Record<string, unknown>, "port");
    return typeof port === "number" && validPort(port) ? port : undefined;
  } catch {
    return undefined;
  }
}

function isPrivateAddress(host: string): boolean {
  const lower = host.toLowerCase();
  if (lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd")) {
    return true;
  }
  if (/^fe[89ab]/.test(lower)) return true;

  const ipv4 = lower.startsWith("::ffff:") ? lower.slice(7) : lower;
  const octets = ipv4.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return false;
  }
  const [first, second] = octets as [number, number, number, number];
  return (
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function validPort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && port <= 65_535;
}

function booleanFields(
  source: Record<string, unknown>,
  keys: string[],
): Record<string, boolean> {
  const fields: Record<string, boolean> = {};
  for (const key of keys) {
    const value = readProperty(source, key);
    if (typeof value === "boolean") fields[key] = value;
  }
  return fields;
}

function keyFields(
  source: Record<string, unknown>,
  keys: string[],
): Record<string, string | Uint8Array> {
  const fields: Record<string, string | Uint8Array> = {};
  for (const key of keys) {
    const value = readProperty(source, key);
    if (typeof value === "string" || b4a.isBuffer(value)) fields[key] = value;
  }
  return fields;
}

function udxStreamSnapshot(rawStream: unknown): Record<string, number> | undefined {
  if (rawStream === null || typeof rawStream !== "object") return undefined;

  const raw = rawStream as Record<string, unknown>;
  const socket =
    raw.socket !== null && typeof raw.socket === "object"
      ? (raw.socket as Record<string, unknown>)
      : undefined;
  const snapshot = {
    ...numericFields(raw, [
      "rtt",
      "cwnd",
      "inflight",
      "rtoCount",
      "retransmits",
      "fastRecoveries",
      "bbrState",
      "bbrBandwidth",
      "bytesTransmitted",
      "packetsTransmitted",
      "bytesReceived",
      "packetsReceived",
    ]),
    ...(socket
      ? numericFields(socket, ["packetsDroppedByKernel"])
      : {}),
  };

  return Object.keys(snapshot).length > 0 ? snapshot : undefined;
}

function numericFields(
  source: Record<string, unknown>,
  keys: string[],
): Record<string, number> {
  const fields: Record<string, number> = {};
  for (const key of keys) {
    const value = readProperty(source, key);
    if (typeof value === "number" && Number.isFinite(value)) {
      fields[key] = value;
    }
  }
  return fields;
}

function readProperty(source: Record<string, unknown>, key: string): unknown {
  try {
    return source[key];
  } catch {
    return undefined;
  }
}
