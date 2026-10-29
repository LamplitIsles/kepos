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
}

export interface DhtKeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

export interface DhtStream extends Duplex {
  connected?: boolean;
  rawStream?: unknown;
  send?: (message: Uint8Array) => Promise<unknown> | unknown;
  trySend?: (message: Uint8Array) => void;
  remotePublicKey: Buffer;
  setKeepAlive?: (intervalMs: number) => void;
  toJSON?: () => unknown;
}

export interface DhtServer {
  close: () => Promise<void>;
  listen: (keyPair: DhtKeyPair) => Promise<void>;
}

export interface DhtNode {
  on?: (event: "wakeup", listener: () => void) => unknown;
  off?: (event: "wakeup", listener: () => void) => unknown;
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

  return sanitizeObservation({
    ...base,
    ...(udx ? { udx } : {}),
  });
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
    ...(socket ? safeCountField(socket, "packetsDroppedByKernel") : {}),
  };

  return Object.keys(snapshot).length > 0 ? snapshot : undefined;
}

function safeCountField(source: Record<string, unknown>, key: string): Record<string, number> {
  const value = readProperty(source, key);
  // Native 64-bit counters may be rounded or expose an unsupported sentinel.
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? { [key]: value }
    : {};
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
