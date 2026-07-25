import { createHash, randomBytes as secureRandomBytes } from "node:crypto";
import { URL } from "node:url";

import b4a from "b4a";
import sodium from "sodium-universal";

const invitationLifetimeMs = 120_000;
const tokenBytes = 32;
const publisherKeyPattern = /^[0-9a-f]{64}$/;
const invitationFields = ["v", "publisher", "name", "token", "expires"] as const;
const maximumInvitationBytes = 2_048;

export interface CreatePairingInvitationOptions {
  publisherKey: string;
  displayName: string;
  now?: () => number;
  randomBytes?: (size: number) => Uint8Array;
}

export interface IssuedPairingInvitation {
  uri: string;
  expiresAt: number;
  tokenDigest: Uint8Array;
}

export interface ParsedPairingInvitation {
  publisherKey: string;
  displayName: string;
  token: string;
  expiresAt: number;
}

export function createPairingInvitation(
  options: CreatePairingInvitationOptions,
): IssuedPairingInvitation {
  const now = (options.now ?? Date.now)();
  const expiresAt =
    Math.floor((now + invitationLifetimeMs) / 1_000) * 1_000;
  const token = (options.randomBytes ?? secureRandomBytes)(tokenBytes);
  if (token.length !== tokenBytes) {
    throw new Error("pairing token must contain exactly 32 random bytes");
  }
  const encodedToken = encodeBase64Url(token);
  const uri = new URL("kepos://pair");
  uri.searchParams.set("v", "1");
  uri.searchParams.set("publisher", parsePublisherKey(options.publisherKey));
  uri.searchParams.set("name", parseDisplayName(options.displayName));
  uri.searchParams.set("token", encodedToken);
  uri.searchParams.set("expires", String(Math.floor(expiresAt / 1_000)));
  return {
    uri: uri.toString(),
    expiresAt,
    tokenDigest: digestToken(token),
  };
}

export function parsePairingInvitation(
  source: string,
  options: { now?: () => number } = {},
): ParsedPairingInvitation {
  if (b4a.byteLength(source, "utf8") > maximumInvitationBytes) {
    throw new Error("pairing invitation URI is too large");
  }
  let uri: URL;
  try {
    uri = new URL(source);
  } catch {
    throw new Error("pairing invitation URI is invalid");
  }
  if (
    uri.protocol !== "kepos:" ||
    uri.hostname !== "pair" ||
    uri.username !== "" ||
    uri.password !== "" ||
    uri.port !== "" ||
    uri.pathname !== "" ||
    uri.hash !== ""
  ) {
    throw new Error("pairing invitation URI is invalid");
  }
  const keys: string[] = [];
  for (const [key] of uri.searchParams) keys.push(key);
  if (
    keys.length !== invitationFields.length ||
    invitationFields.some(
      (field) => uri.searchParams.getAll(field).length !== 1,
    ) ||
    keys.some(
      (field) => !(invitationFields as readonly string[]).includes(field),
    )
  ) {
    throw new Error("pairing invitation fields are invalid");
  }
  if (uri.searchParams.get("v") !== "1") {
    throw new Error("pairing invitation version is unsupported");
  }
  const expires = uri.searchParams.get("expires");
  if (!expires || !/^[1-9][0-9]*$/u.test(expires)) {
    throw new Error("pairing invitation expiry is invalid");
  }
  const expiresAt = Number(expires) * 1_000;
  if (!Number.isSafeInteger(expiresAt)) {
    throw new Error("pairing invitation expiry is invalid");
  }
  if (expiresAt <= (options.now ?? Date.now)()) {
    throw new Error("pairing invitation has expired");
  }
  const token = uri.searchParams.get("token") ?? "";
  decodeToken(token);
  return {
    publisherKey: parsePublisherKey(uri.searchParams.get("publisher") ?? ""),
    displayName: parseDisplayName(uri.searchParams.get("name") ?? ""),
    token,
    expiresAt,
  };
}

export function pairingTokenMatches(
  token: string,
  expectedDigest: Uint8Array,
): boolean {
  if (expectedDigest.length !== 32) return false;
  try {
    return sodium.sodium_memcmp(digestToken(decodeToken(token)), expectedDigest);
  } catch {
    return false;
  }
}

function parsePublisherKey(value: string): string {
  if (!publisherKeyPattern.test(value)) {
    throw new Error("pairing publisher key must be 32 bytes of lowercase hex");
  }
  return value;
}

function parseDisplayName(value: string): string {
  if (
    value.length === 0 ||
    value.trim() !== value ||
    b4a.byteLength(value, "utf8") > 128 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error("pairing publisher display name is invalid");
  }
  return value;
}

function encodeBase64Url(value: Uint8Array): string {
  return b4a
    .toString(value, "base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decodeToken(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) {
    throw new Error("pairing token is invalid");
  }
  const decoded = b4a.from(
    value.replaceAll("-", "+").replaceAll("_", "/") + "=",
    "base64",
  );
  if (decoded.length !== tokenBytes || encodeBase64Url(decoded) !== value) {
    throw new Error("pairing token is invalid");
  }
  return decoded;
}

function digestToken(value: Uint8Array): Uint8Array {
  return createHash("sha256").update(value).digest();
}
