import compactModule from "compact-encoding";
import b4a from "b4a";

const maximumMessageBytes = 4_096;
const maximumLabelBytes = 128;
const maximumPlatformBytes = 32;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/u;
const platformPattern = /^[a-z0-9][a-z0-9_-]*$/u;
const errorCodes = new Set([
  "invalid-request",
  "invitation-unavailable",
  "persistence-failed",
]);

interface EncodingState {
  start: number;
  end: number;
  buffer: Uint8Array;
}

interface Encoding<T> {
  decode(state: unknown): T;
  encode(state: unknown, value: T): void;
  preencode(state: unknown, value: T): void;
}

interface CompactEncoding {
  uint: Encoding<number>;
}

export interface PairingRequest {
  token: string;
  label: string;
  platform: string;
}

export type PairingResponse =
  | { status: "pending" }
  | { status: "approved" }
  | { status: "denied" }
  | {
      status: "error";
      code:
        | "invalid-request"
        | "invitation-unavailable"
        | "persistence-failed";
    };

const c = compactModule as CompactEncoding;

export const pairingRequestEncoding = jsonEncoding(
  "pairing request",
  parsePairingRequest,
);

export const pairingResponseEncoding = jsonEncoding(
  "pairing response",
  parsePairingResponse,
);

function jsonEncoding<T>(
  label: string,
  parse: (value: unknown) => T,
): Encoding<T> {
  return {
    preencode(state, value): void {
      const target = state as EncodingState;
      const bytes = serialize(label, parse(value));
      c.uint.preencode(target, bytes.length);
      target.end += bytes.length;
    },
    encode(state, value): void {
      const target = state as EncodingState;
      const bytes = serialize(label, parse(value));
      c.uint.encode(target, bytes.length);
      target.buffer.set(bytes, target.start);
      target.start += bytes.length;
    },
    decode(state): T {
      const target = state as EncodingState;
      const length = c.uint.decode(target);
      if (length > maximumMessageBytes) {
        throw new Error("pairing message is too large");
      }
      if (length !== target.end - target.start) {
        throw new Error(`${label} frame is invalid`);
      }
      let decoded: unknown;
      try {
        const bytes = target.buffer.subarray(target.start, target.end);
        const text = b4a.toString(bytes, "utf8");
        if (!b4a.equals(b4a.from(text, "utf8"), bytes)) {
          throw new Error("invalid UTF-8");
        }
        decoded = JSON.parse(text);
      } catch {
        throw new Error(`${label} payload is invalid`);
      }
      target.start = target.end;
      return parse(decoded);
    },
  };
}

function serialize(label: string, value: unknown): Uint8Array {
  const bytes = b4a.from(JSON.stringify(value), "utf8");
  if (bytes.length > maximumMessageBytes) {
    throw new Error(`${label} is too large`);
  }
  return bytes;
}

function parsePairingRequest(value: unknown): PairingRequest {
  if (!isRecordWithKeys(value, ["token", "label", "platform"])) {
    throw new Error("pairing request fields are invalid");
  }
  const { token, label, platform } = value;
  if (typeof token !== "string" || !tokenPattern.test(token)) {
    throw new Error("pairing request token is invalid");
  }
  if (!isBoundedLabel(label)) {
    throw new Error("pairing request label is invalid");
  }
  if (
    typeof platform !== "string" ||
    b4a.byteLength(platform, "utf8") > maximumPlatformBytes ||
    !platformPattern.test(platform)
  ) {
    throw new Error("pairing request platform is invalid");
  }
  return { token, label, platform };
}

function parsePairingResponse(value: unknown): PairingResponse {
  if (!isRecord(value) || typeof value.status !== "string") {
    throw new Error("pairing response is invalid");
  }
  if (
    value.status === "pending" ||
    value.status === "approved" ||
    value.status === "denied"
  ) {
    if (!hasExactKeys(value, ["status"])) {
      throw new Error("pairing response fields are invalid");
    }
    return { status: value.status };
  }
  if (
    value.status !== "error" ||
    !hasExactKeys(value, ["status", "code"]) ||
    typeof value.code !== "string" ||
    !errorCodes.has(value.code)
  ) {
    throw new Error("pairing response is invalid");
  }
  return value as PairingResponse;
}

function isBoundedLabel(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.trim() === value &&
    b4a.byteLength(value, "utf8") <= maximumLabelBytes &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRecordWithKeys(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return isRecord(value) && hasExactKeys(value, keys);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length && keys.every((key) => key in value)
  );
}
