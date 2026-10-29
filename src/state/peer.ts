import path from "node:path";

import {
  derivePeerPublicKey,
  generatePeerSeed,
} from "../keys.js";
import {
  pathExists,
  readStateJson,
  validateStateDirectory,
  writeStateDirectoryAtomically,
} from "./files.js";

const identityFileName = "peer.json";
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
    return { created: false, publicKey: derivePeerPublicKey(identity.seed) };
  }
  const identity = parsePeerIdentity({
    seed: randomSeed(),
  });
  await writeStateDirectoryAtomically(
    stateDir,
    new Map([[identityFileName, serializePeerIdentity(identity)]]),
  );
  return { created: true, publicKey: derivePeerPublicKey(identity.seed) };
}

export async function loadPeerIdentity(stateDir: string): Promise<PeerIdentity> {
  stateDir = path.resolve(stateDir);
  await validateStateDirectory(stateDir, [identityFileName]);
  return parsePeerIdentity(await readStateJson(path.join(stateDir, identityFileName)));
}

export async function getPeerPublicKey(stateDir: string): Promise<string> {
  const identity = await loadPeerIdentity(stateDir);
  return derivePeerPublicKey(identity.seed);
}

function randomSeed(): string {
  return generatePeerSeed();
}
