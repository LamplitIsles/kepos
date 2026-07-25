export const PROTOCOL_VERSION = 1;

export type HostMethod = "configure" | "pair" | "ping" | "status" | "stop";
export type HostEvent = "runtime.stateChanged";

export interface RequestEnvelope {
  version: 1;
  kind: "request";
  id: number;
  method: HostMethod;
  params?: unknown;
}

export interface ResponseEnvelope {
  version: 1;
  kind: "response";
  id: number;
  result: unknown;
}

export interface ErrorEnvelope {
  version: 1;
  kind: "error";
  id: number;
  error: {
    code: string;
    message: string;
  };
}

export interface EventEnvelope {
  version: 1;
  kind: "event";
  event: HostEvent;
  data: unknown;
}

export type HostEnvelope =
  | RequestEnvelope
  | ResponseEnvelope
  | ErrorEnvelope
  | EventEnvelope;

export function parseEnvelope(value: unknown): HostEnvelope {
  if (!isRecord(value)) throw new Error("control envelope must be an object");
  if (value.version !== PROTOCOL_VERSION) {
    throw new Error("unsupported control protocol version");
  }
  if (value.kind === "request") return parseRequest(value);
  if (value.kind === "response") {
    requireRequestId(value.id);
    if (!("result" in value)) throw new Error("control response has no result");
    return {
      version: PROTOCOL_VERSION,
      kind: "response",
      id: value.id,
      result: value.result,
    };
  }
  if (value.kind === "error") {
    requireRequestId(value.id);
    if (!isRecord(value.error)) throw new Error("control error is malformed");
    if (!isNonEmptyString(value.error.code)) {
      throw new Error("control error code must be a non-empty string");
    }
    if (!isNonEmptyString(value.error.message)) {
      throw new Error("control error message must be a non-empty string");
    }
    return {
      version: PROTOCOL_VERSION,
      kind: "error",
      id: value.id,
      error: { code: value.error.code, message: value.error.message },
    };
  }
  if (value.kind === "event") {
    if (value.event !== "runtime.stateChanged") {
      throw new Error("unsupported control event");
    }
    if (!("data" in value)) throw new Error("control event has no data");
    return {
      version: PROTOCOL_VERSION,
      kind: "event",
      event: value.event,
      data: value.data,
    };
  }
  throw new Error("unsupported control envelope kind");
}

function parseRequest(value: Record<string, unknown>): RequestEnvelope {
  requireRequestId(value.id);
  if (
    value.method !== "ping" &&
    value.method !== "status" &&
    value.method !== "stop" &&
    value.method !== "configure" &&
    value.method !== "pair"
  ) {
    throw new Error("unsupported control request method");
  }
  return {
    version: PROTOCOL_VERSION,
    kind: "request",
    id: value.id,
    method: value.method,
    ...(Object.hasOwn(value, "params") ? { params: value.params } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRequestId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function requireRequestId(value: unknown): asserts value is number {
  if (!isRequestId(value)) {
    throw new Error("control request id must be a positive integer");
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
