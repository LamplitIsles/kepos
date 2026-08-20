import b4a from "b4a";

import type {
  Observation,
  ObservationDirection,
  ObservationName,
  ObservationRole,
} from "../../../src/mux/observability.js";

export const DESKTOP_DIAGNOSTIC_EVENT_MAX_BYTES = 8 * 1024;

const maximumDiagnosticNumber = 1_000_000_000_000;
const outerIdPattern = /^outer-[0-9a-f]{16}$/;
const channelIdPattern = /^[0-9a-f]{32}$/;
const serviceIdPattern = /^[a-z][a-z0-9-]{0,63}$/;
const fingerprintPattern = /^[0-9a-f]{16,64}$/;
const routeValues = new Set(["auto", "public"]);
const firewallValues = new Set(["unknown", "open", "consistent", "random"]);
const directionValues = new Set<ObservationDirection>([
  "subscriber-to-publisher",
  "publisher-to-subscriber",
]);
const observationRoles = new Set<ObservationRole>(["publisher", "subscriber"]);
const observationNames = new Set<ObservationName>([
  "outer.attempt",
  "outer.handshake",
  "outer.holepunch",
  "outer.connected",
  "outer.control-ready",
  "outer.unhealthy",
  "outer.retry",
  "outer.restored",
  "outer.closed",
  "outer.accepted",
  "outer.rejected",
  "outer.replaced",
  "pairing.invitation-created",
  "pairing.invitation-expired",
  "pairing.requested",
  "pairing.rejected",
  "pairing.approved",
  "pairing.denied",
  "pairing.cancelled",
  "pairing.approval-error",
  "channel.open",
  "channel.open-ok",
  "channel.open-error",
  "channel.first-byte",
  "channel.fin",
  "channel.reset",
  "channel.pause",
  "channel.resume",
  "channel.close",
]);
const triggerValues = new Set([
  "local.stop",
  "stream.error",
  "stream.close",
  "connect.error",
  "subscriber.replaced",
  "local.close",
  "remote.close",
  "local.error",
  "remote.open-error",
  "remote.reset",
  "target.close",
  "target.error",
  "control.establishment.timeout",
  "control.unexpected-close",
  "heartbeat.timeout",
  "home.registry.timeout",
]);
const transportNumberFields = [
  "elapsedMs",
  "attempt",
  "attemptElapsedMs",
  "recoveryAttempt",
  "recoveryElapsedMs",
  "delayMs",
  "durationMs",
  "bytes",
  "remoteAddressCount",
  "localAddressCount",
  "subscriberToPublisherBytes",
  "publisherToSubscriberBytes",
  "subscriberToPublisherFirstByteMs",
  "publisherToSubscriberFirstByteMs",
  "subscriberToPublisherTransferMs",
  "publisherToSubscriberTransferMs",
  "subscriberToPublisherBytesPerSecond",
  "publisherToSubscriberBytesPerSecond",
  "lastPongElapsedMs",
  "missedPongs",
  "expiresAt",
] as const;

export const DESKTOP_DIAGNOSTIC_ERROR_CATEGORIES = [
  "unknown",
  "timeout",
  "permission",
  "not-found",
  "invalid",
  "conflict",
  "unavailable",
  "size",
] as const;

export type DesktopDiagnosticErrorCategory =
  (typeof DESKTOP_DIAGNOSTIC_ERROR_CATEGORIES)[number];

export function isDesktopDiagnosticErrorCategory(
  value: unknown,
): value is DesktopDiagnosticErrorCategory {
  return (
    typeof value === "string" &&
    DESKTOP_DIAGNOSTIC_ERROR_CATEGORIES.includes(
      value as DesktopDiagnosticErrorCategory,
    )
  );
}

export type DesktopDiagnosticLifecyclePhase =
  "starting" | "running" | "stopping" | "stopped";

export type DesktopDiagnosticConfigOperation = "load" | "save" | "apply";
export type DesktopDiagnosticConfigOutcome = "success" | "failed";
export type DesktopDiagnosticRegistryOutcome = "success" | "retry" | "failed";

export type DesktopDiagnosticDeviceObservation =
  | {
      source: "device";
      timestamp: string;
      event: "desktop.lifecycle";
      phase: DesktopDiagnosticLifecyclePhase;
    }
  | {
      source: "device";
      timestamp: string;
      event: "desktop.config";
      operation: DesktopDiagnosticConfigOperation;
      outcome: DesktopDiagnosticConfigOutcome;
      errorCategory?: DesktopDiagnosticErrorCategory;
    }
  | {
      source: "device";
      timestamp: string;
      event: "desktop.registry";
      outcome: DesktopDiagnosticRegistryOutcome;
      connectionGeneration: number;
      serviceCount: number;
      errorCategory?: DesktopDiagnosticErrorCategory;
    };

export type DesktopDiagnosticObservation =
  Observation | DesktopDiagnosticDeviceObservation;
export type DesktopObservationCallback = (
  observation: DesktopDiagnosticObservation,
) => void;

export interface DesktopDiagnosticDhtCounters {
  punches?: {
    consistent?: number;
    random?: number;
    open?: number;
  };
  relaying?: {
    attempts?: number;
    successes?: number;
    aborts?: number;
  };
}

export interface DesktopDiagnosticTransportEvent {
  source: "transport";
  timestamp: string;
  role: ObservationRole;
  event: ObservationName;
  route?: "auto" | "public";
  outerId?: string;
  replacementOuterId?: string;
  channelId?: string;
  serviceId?: string;
  direction?: ObservationDirection;
  trigger?: string;
  publicKey?: string;
  remotePublicKey?: string;
  remoteFirewall?: "unknown" | "open" | "consistent" | "random";
  localFirewall?: "unknown" | "open" | "consistent" | "random";
  dht?: DesktopDiagnosticDhtCounters;
  elapsedMs?: number;
  attempt?: number;
  attemptElapsedMs?: number;
  recoveryAttempt?: number;
  recoveryElapsedMs?: number;
  delayMs?: number;
  durationMs?: number;
  bytes?: number;
  remoteAddressCount?: number;
  localAddressCount?: number;
  subscriberToPublisherBytes?: number;
  publisherToSubscriberBytes?: number;
  subscriberToPublisherFirstByteMs?: number;
  publisherToSubscriberFirstByteMs?: number;
  subscriberToPublisherTransferMs?: number;
  publisherToSubscriberTransferMs?: number;
  subscriberToPublisherBytesPerSecond?: number;
  publisherToSubscriberBytesPerSecond?: number;
  lastPongElapsedMs?: number;
  missedPongs?: number;
  expiresAt?: number;
}

export type DesktopDiagnosticEvent =
  DesktopDiagnosticTransportEvent | DesktopDiagnosticDeviceObservation;

export function createDesktopLifecycleObservation(
  phase: DesktopDiagnosticLifecyclePhase,
  now: () => number = Date.now,
): DesktopDiagnosticDeviceObservation {
  return {
    source: "device",
    timestamp: timestampFor(now),
    event: "desktop.lifecycle",
    phase,
  };
}

export function createDesktopConfigObservation(
  operation: DesktopDiagnosticConfigOperation,
  outcome: DesktopDiagnosticConfigOutcome,
  error?: unknown,
  now: () => number = Date.now,
): DesktopDiagnosticDeviceObservation {
  return {
    source: "device",
    timestamp: timestampFor(now),
    event: "desktop.config",
    operation,
    outcome,
    ...(outcome === "failed"
      ? { errorCategory: desktopDiagnosticErrorCategory(error) }
      : {}),
  };
}

export function createDesktopRegistryObservation(
  outcome: DesktopDiagnosticRegistryOutcome,
  connectionGeneration: number,
  serviceCount: number,
  error?: unknown,
  now: () => number = Date.now,
): DesktopDiagnosticDeviceObservation {
  return {
    source: "device",
    timestamp: timestampFor(now),
    event: "desktop.registry",
    outcome,
    connectionGeneration: boundedCount(connectionGeneration) ?? 0,
    serviceCount: boundedCount(serviceCount) ?? 0,
    ...(outcome === "success"
      ? {}
      : { errorCategory: desktopDiagnosticErrorCategory(error) }),
  };
}

export function desktopDiagnosticErrorCategory(
  error: unknown,
): DesktopDiagnosticErrorCategory {
  let code = "";
  let name = "";
  let message = "";
  try {
    if (isRecord(error)) {
      if (typeof error.code === "string") code = error.code;
      if (typeof error.name === "string") name = error.name;
    }
    if (error instanceof Error) {
      name ||= error.name;
      message = error.message;
    } else if (typeof error === "string") {
      message = error;
    }
  } catch {
    return "unknown";
  }

  const source = `${code} ${name} ${message}`.toLowerCase();
  if (
    source.includes("exceeds") ||
    source.includes("64 kib") ||
    source.includes("size")
  ) {
    return "size";
  }
  if (source.includes("timeout") || source.includes("timed out")) {
    return "timeout";
  }
  if (
    source.includes("eacces") ||
    source.includes("eperm") ||
    source.includes("permission") ||
    source.includes("access denied")
  ) {
    return "permission";
  }
  if (source.includes("enoent") || source.includes("not found")) {
    return "not-found";
  }
  if (
    source.includes("invalid") ||
    source.includes("unsupported") ||
    source.includes("malformed")
  ) {
    return "invalid";
  }
  if (
    source.includes("already running") ||
    source.includes("already in use") ||
    source.includes("eexist") ||
    source.includes("conflict")
  ) {
    return "conflict";
  }
  if (
    source.includes("unavailable") ||
    source.includes("refused") ||
    source.includes("eaddr") ||
    source.includes("503")
  ) {
    return "unavailable";
  }
  return "unknown";
}

export function normalizeDesktopDiagnosticEvent(
  value: unknown,
): DesktopDiagnosticEvent | undefined {
  if (!isRecord(value)) return undefined;
  if (value.source === "device") return normalizeDeviceEvent(value);
  if (value.source === "transport") {
    return normalizeTransportEvent(value, true);
  }
  if (value.component !== "kepos") return undefined;
  return normalizeTransportEvent(value, false);
}

export function serializeDesktopDiagnosticEvent(value: unknown): string {
  const rawSerialized = serializeRawDiagnosticInput(value);
  if (
    rawSerialized !== undefined &&
    b4a.byteLength(rawSerialized, "utf8") + 1 >
      DESKTOP_DIAGNOSTIC_EVENT_MAX_BYTES
  ) {
    throw new Error("desktop diagnostic event exceeds 8 KiB");
  }

  const event = normalizeDesktopDiagnosticEvent(value);
  if (!event) throw new Error("desktop diagnostic event is invalid");
  const serialized = JSON.stringify(event);
  if (
    b4a.byteLength(serialized, "utf8") + 1 >
    DESKTOP_DIAGNOSTIC_EVENT_MAX_BYTES
  ) {
    throw new Error("desktop diagnostic event exceeds 8 KiB");
  }
  return serialized;
}

function normalizeDeviceEvent(
  value: Record<string, unknown>,
): DesktopDiagnosticDeviceObservation | undefined {
  const timestamp = normalizeTimestamp(value.timestamp);
  if (!timestamp || value.source !== "device") return undefined;

  if (value.event === "desktop.lifecycle") {
    if (!isLifecyclePhase(value.phase)) return undefined;
    return {
      source: "device",
      timestamp,
      event: value.event,
      phase: value.phase,
    };
  }

  if (value.event === "desktop.config") {
    if (!isConfigOperation(value.operation)) return undefined;
    if (value.outcome === "success") {
      return {
        source: "device",
        timestamp,
        event: value.event,
        operation: value.operation,
        outcome: value.outcome,
      };
    }
    if (value.outcome !== "failed") return undefined;
    const errorCategory = normalizeErrorCategory(value.errorCategory);
    if (!errorCategory) return undefined;
    return {
      source: "device",
      timestamp,
      event: value.event,
      operation: value.operation,
      outcome: value.outcome,
      errorCategory,
    };
  }

  if (value.event === "desktop.registry") {
    if (!isRegistryOutcome(value.outcome)) return undefined;
    const connectionGeneration = boundedCount(value.connectionGeneration);
    const serviceCount = boundedCount(value.serviceCount);
    if (connectionGeneration === undefined || serviceCount === undefined) {
      return undefined;
    }
    if (value.outcome === "success") {
      return {
        source: "device",
        timestamp,
        event: value.event,
        outcome: value.outcome,
        connectionGeneration,
        serviceCount,
      };
    }
    const errorCategory = normalizeErrorCategory(value.errorCategory);
    if (!errorCategory) return undefined;
    return {
      source: "device",
      timestamp,
      event: value.event,
      outcome: value.outcome,
      connectionGeneration,
      serviceCount,
      errorCategory,
    };
  }

  return undefined;
}

function normalizeTransportEvent(
  value: Record<string, unknown>,
  sourceAlreadyNormalized: boolean,
): DesktopDiagnosticTransportEvent | undefined {
  if (!sourceAlreadyNormalized && value.component !== "kepos") return undefined;
  const timestamp = normalizeTimestamp(value.timestamp);
  const role = normalizeObservationRole(value.role);
  const event = normalizeObservationName(value.event);
  if (!timestamp || !role || !event) return undefined;

  const output: Record<string, unknown> = {
    source: "transport",
    timestamp,
    role,
    event,
  };
  if (routeValues.has(value.route as string)) output.route = value.route;
  copyId(value, output, "outerId", outerIdPattern);
  copyId(value, output, "replacementOuterId", outerIdPattern);
  copyId(value, output, "channelId", channelIdPattern);
  if (
    typeof value.serviceId === "string" &&
    serviceIdPattern.test(value.serviceId)
  ) {
    output.serviceId = value.serviceId;
  }
  if (directionValues.has(value.direction as ObservationDirection)) {
    output.direction = value.direction;
  }
  const trigger = normalizeTrigger(value.trigger ?? value.reason);
  if (trigger) output.trigger = trigger;
  const publicKey = normalizeFingerprint(value.publicKey);
  const remotePublicKey = normalizeFingerprint(value.remotePublicKey);
  if (publicKey) output.publicKey = publicKey;
  if (remotePublicKey) output.remotePublicKey = remotePublicKey;
  if (firewallValues.has(value.remoteFirewall as string)) {
    output.remoteFirewall = value.remoteFirewall;
  }
  if (firewallValues.has(value.localFirewall as string)) {
    output.localFirewall = value.localFirewall;
  }

  for (const field of transportNumberFields) {
    const number = boundedNumber(value[field]);
    if (number !== undefined) output[field] = number;
  }
  const dht = normalizeDhtCounters(value.dht);
  if (dht) output.dht = dht;
  return output as unknown as DesktopDiagnosticTransportEvent;
}

function normalizeDhtCounters(
  value: unknown,
): DesktopDiagnosticDhtCounters | undefined {
  if (!isRecord(value)) return undefined;
  const output: Record<string, unknown> = {};
  const punches = normalizeNumberRecord(value.punches, [
    "consistent",
    "random",
    "open",
  ] as const);
  const relaying = normalizeNumberRecord(value.relaying, [
    "attempts",
    "successes",
    "aborts",
  ] as const);
  if (punches) output.punches = punches;
  if (relaying) output.relaying = relaying;
  return Object.keys(output).length > 0
    ? (output as DesktopDiagnosticDhtCounters)
    : undefined;
}

function normalizeNumberRecord<const T extends readonly string[]>(
  value: unknown,
  fields: T,
): Record<T[number], number> | undefined {
  if (!isRecord(value)) return undefined;
  const output: Record<string, number> = {};
  for (const field of fields) {
    const number = boundedNumber(value[field]);
    if (number !== undefined) output[field] = number;
  }
  return Object.keys(output).length > 0
    ? (output as Record<T[number], number>)
    : undefined;
}

function normalizeTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || b4a.byteLength(value, "utf8") > 64) {
    return undefined;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return undefined;
  return new Date(parsed).toISOString();
}

function normalizeFingerprint(value: unknown): string | undefined {
  let source: string | undefined;
  if (typeof value === "string") {
    source = value;
  } else if (b4a.isBuffer(value)) {
    source = b4a.toString(value, "hex");
  }
  if (!source || !fingerprintPattern.test(source)) return undefined;
  return source.slice(0, 16);
}

function normalizeTrigger(value: unknown): string | undefined {
  return typeof value === "string" && triggerValues.has(value)
    ? value
    : undefined;
}

function boundedNumber(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= maximumDiagnosticNumber
    ? value
    : undefined;
}

function boundedCount(value: unknown): number | undefined {
  return boundedNumber(value);
}

function copyId(
  source: Record<string, unknown>,
  destination: Record<string, unknown>,
  field: string,
  pattern: RegExp,
): void {
  if (typeof source[field] === "string" && pattern.test(source[field])) {
    destination[field] = source[field];
  }
}

function normalizeObservationRole(value: unknown): ObservationRole | undefined {
  return typeof value === "string" &&
    observationRoles.has(value as ObservationRole)
    ? (value as ObservationRole)
    : undefined;
}

function normalizeObservationName(value: unknown): ObservationName | undefined {
  return typeof value === "string" &&
    observationNames.has(value as ObservationName)
    ? (value as ObservationName)
    : undefined;
}

function normalizeErrorCategory(
  value: unknown,
): DesktopDiagnosticErrorCategory | undefined {
  return isDesktopDiagnosticErrorCategory(value) ? value : undefined;
}

function isLifecyclePhase(
  value: unknown,
): value is DesktopDiagnosticLifecyclePhase {
  return (
    value === "starting" ||
    value === "running" ||
    value === "stopping" ||
    value === "stopped"
  );
}

function isConfigOperation(
  value: unknown,
): value is DesktopDiagnosticConfigOperation {
  return value === "load" || value === "save" || value === "apply";
}

function isRegistryOutcome(
  value: unknown,
): value is DesktopDiagnosticRegistryOutcome {
  return value === "success" || value === "retry" || value === "failed";
}

function timestampFor(now: () => number): string {
  try {
    const value = now();
    return Number.isFinite(value)
      ? new Date(value).toISOString()
      : new Date(0).toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

function serializeRawDiagnosticInput(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
