import path from "node:path";
import { lstat, readFile } from "node:fs/promises";

import {
  derivePublisherHomeKey,
  generatePublisherSeed,
  parseClientIdentity,
} from "../keys.js";
import {
  pathExists,
  readStateJson,
  validateStateDirectory,
  writeStateDirectoryAtomically,
} from "./files.js";

const identityFileName = "peer.json";
const legacyPublisherFileName = "publisher.json";
const legacySubscriberFileName = "client.identity.json";
const publicKeyPattern = /^[0-9a-f]{64}$/u;

export interface PeerIdentity {
  seed: string;
}

export interface SetupPeerOptions {
  stateDir: string;
}

export interface SetupPeerResult {
  created: boolean;
  publicKey: string;
}

export interface ConvertPeerIdentityOptions {
  /** Explicit old publisher state directory or identity file. */
  source: string;
  /** New peer state directory; it must not already exist. */
  destination: string;
  /** Required deployment assertion for the retained public key. */
  expectedPublicKey: string;
}

export interface ConvertPeerIdentityResult {
  destination: string;
  publicKey: string;
}

export function parsePeerIdentity(value: unknown): PeerIdentity {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => key !== "seed")
  ) {
    throw new Error("peer identity must be an object with only seed");
  }
  const seed = (value as { seed?: unknown }).seed;
  if (typeof seed !== "string" || !publicKeyPattern.test(seed)) {
    throw new Error("peer identity seed must be 32 bytes of lowercase hex");
  }
  return { seed };
}

export function serializePeerIdentity(identity: PeerIdentity): string {
  const parsed = parsePeerIdentity(identity);
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

export async function setupPeer(
  options: SetupPeerOptions,
): Promise<SetupPeerResult> {
  const stateDir = path.resolve(options.stateDir);
  if (await pathExists(stateDir)) {
    const identity = await loadPeerIdentity(stateDir);
    return { created: false, publicKey: derivePublisherHomeKey(identity.seed) };
  }
  const identity = parsePeerIdentity({
    seed: randomSeed(),
  });
  await writeStateDirectoryAtomically(
    stateDir,
    new Map([[identityFileName, serializePeerIdentity(identity)]]),
  );
  return { created: true, publicKey: derivePublisherHomeKey(identity.seed) };
}

export async function ensurePeer(
  options: SetupPeerOptions,
): Promise<SetupPeerResult> {
  return setupPeer(options);
}

export async function loadPeerIdentity(stateDir: string): Promise<PeerIdentity> {
  stateDir = path.resolve(stateDir);
  await validateStateDirectory(stateDir, [identityFileName]);
  return parsePeerIdentity(await readStateJson(path.join(stateDir, identityFileName)));
}

export async function getPeerPublicKey(stateDir: string): Promise<string> {
  const identity = await loadPeerIdentity(stateDir);
  return derivePublisherHomeKey(identity.seed);
}

/**
 * Convert one explicitly selected legacy identity offline.  This function is
 * intentionally not imported by runtime startup: the canonical runtime only
 * reads peer.json and never probes legacy paths.
 */
export async function convertPeerIdentity(
  options: ConvertPeerIdentityOptions,
): Promise<ConvertPeerIdentityResult> {
  const source = path.resolve(options.source);
  const destination = path.resolve(options.destination);
  if (source === destination || destination.startsWith(`${source}${path.sep}`)) {
    throw new Error("peer identity destination must be outside the source");
  }
  if (await pathExists(destination)) {
    throw new Error(`peer identity destination already exists: ${destination}`);
  }
  if (!publicKeyPattern.test(options.expectedPublicKey)) {
    throw new Error("expected public key must be 32 bytes of lowercase hex");
  }
  const identity = await readLegacyIdentity(source);
  const publicKey = derivePublisherHomeKey(identity.seed);
  if (options.expectedPublicKey !== publicKey) {
    throw new Error("converted peer identity does not match expected public key");
  }
  await writeStateDirectoryAtomically(
    destination,
    new Map([[identityFileName, serializePeerIdentity(identity)]]),
  );
  return { destination, publicKey };
}

async function readLegacyIdentity(source: string): Promise<PeerIdentity> {
  const sourceStat = await lstat(source).catch((error: unknown) => {
    throw new Error(`cannot read peer identity source: ${source}`, { cause: error });
  });
  if (sourceStat.isSymbolicLink()) {
    throw new Error("peer identity source must not be a symbolic link");
  }
  if (sourceStat.isFile()) {
    return parseLegacyIdentityFile(source, path.basename(source));
  }
  if (!sourceStat.isDirectory()) {
    throw new Error("peer identity source must be a regular file or directory");
  }
  const publisherPath = path.join(source, legacyPublisherFileName);
  const subscriberPath = path.join(source, legacySubscriberFileName);
  const hasPublisher = await pathExists(publisherPath);
  const hasSubscriber = await pathExists(subscriberPath);
  if (hasPublisher === hasSubscriber) {
    throw new Error(
      "legacy identity source must contain exactly one publisher.json or client.identity.json",
    );
  }
  return parseLegacyIdentityFile(
    hasPublisher ? publisherPath : subscriberPath,
    hasPublisher ? legacyPublisherFileName : legacySubscriberFileName,
  );
}

async function parseLegacyIdentityFile(
  filePath: string,
  fileName: string,
): Promise<PeerIdentity> {
  const fileStat = await lstat(filePath);
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
    throw new Error(`legacy identity must be a regular file: ${filePath}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(await readFile(filePath, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`invalid legacy identity: ${filePath}`, { cause: error });
  }
  if (fileName === legacyPublisherFileName) {
    return parsePeerIdentity(value);
  }
  if (fileName === legacySubscriberFileName) {
    const identity = parseClientIdentity(value);
    return parsePeerIdentity({ seed: identity.secretKey.slice(0, 64) });
  }
  throw new Error(
    "legacy identity source must be publisher.json or client.identity.json",
  );
}

function randomSeed(): string {
  return generatePublisherSeed();
}
