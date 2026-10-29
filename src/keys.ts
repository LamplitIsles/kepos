import b4a from "b4a";
import crypto from "hypercore-crypto";
import HyperDhtModule from "hyperdht";

interface HyperDhtKeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

interface HyperDhtModule {
  keyPair(seed?: Uint8Array): HyperDhtKeyPair;
}

const HyperDHT = HyperDhtModule as HyperDhtModule;
const publicKeyPattern = /^[0-9a-f]{64}$/;

function deriveKeyPair(seed: Uint8Array): HyperDhtKeyPair {
  const pair = HyperDHT.keyPair(seed);
  if (pair.publicKey.length !== 32 || pair.secretKey.length !== 64) {
    throw new Error("HyperDHT returned an invalid keypair");
  }

  return pair;
}

export function generatePeerSeed(): string {
  return b4a.toString(crypto.randomBytes(32), "hex");
}

export function derivePeerPublicKey(seed: string): string {
  if (!publicKeyPattern.test(seed)) {
    throw new Error("peer seed must be 32 bytes of lowercase hex");
  }

  return b4a.toString(deriveKeyPair(b4a.from(seed, "hex")).publicKey, "hex");
}
