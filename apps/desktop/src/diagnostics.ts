import {
  appendFile,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import b4a from "b4a";

import type {
  Observation,
  ObservationDirection,
  ObservationName,
  ObservationRole,
} from "../../../src/mux/observability.js";
import type { DesktopSnapshot } from "./protocol.js";

export const DESKTOP_DIAGNOSTIC_EVENT_MAX_BYTES = 8 * 1024;
export const DESKTOP_DIAGNOSTIC_ACTIVE_MAX_BYTES = 256 * 1024;
export const DESKTOP_DIAGNOSTIC_ROTATED_FILE_COUNT = 3;
export const DESKTOP_DIAGNOSTIC_TOTAL_MAX_BYTES =
  DESKTOP_DIAGNOSTIC_ACTIVE_MAX_BYTES *
  (DESKTOP_DIAGNOSTIC_ROTATED_FILE_COUNT + 1);
export const DESKTOP_DIAGNOSTIC_QUEUE_LIMIT = 256;
export const DESKTOP_DIAGNOSTIC_SHUTDOWN_TIMEOUT_MS = 250;
export const DESKTOP_DIAGNOSTIC_SUMMARY_MAX_BYTES = 64 * 1024;
export const DESKTOP_DIAGNOSTIC_SUMMARY_MAX_EVENTS = 200;
export const DESKTOP_DIAGNOSTIC_ACTIVE_FILE = "diagnostics.log";

const diagnosticFileNames = [
  DESKTOP_DIAGNOSTIC_ACTIVE_FILE,
  "diagnostics.1.log",
  "diagnostics.2.log",
  "diagnostics.3.log",
] as const;
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
const observationRoles = new Set<ObservationRole>([
  "publisher",
  "subscriber",
]);
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
const diagnosticErrorCategories = new Set<DesktopDiagnosticErrorCategory>([
  "unknown",
  "timeout",
  "permission",
  "not-found",
  "invalid",
  "conflict",
  "unavailable",
  "size",
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
const udxNumberFields = [
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
  "packetsDroppedByKernel",
] as const;

export type DesktopDiagnosticErrorCategory =
  | "unknown"
  | "timeout"
  | "permission"
  | "not-found"
  | "invalid"
  | "conflict"
  | "unavailable"
  | "size";

export type DesktopDiagnosticLifecyclePhase =
  | "starting"
  | "running"
  | "stopping"
  | "stopped";

export type DesktopDiagnosticConfigOperation = "load" | "save" | "apply";
export type DesktopDiagnosticConfigOutcome = "success" | "failed";
export type DesktopDiagnosticRegistryOutcome =
  | "success"
  | "retry"
  | "failed";

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
  | Observation
  | DesktopDiagnosticDeviceObservation;
export type DesktopObservationCallback = (
  observation: DesktopDiagnosticObservation,
) => void;

export interface DesktopDiagnosticUdxSnapshot {
  rtt?: number;
  cwnd?: number;
  inflight?: number;
  rtoCount?: number;
  retransmits?: number;
  fastRecoveries?: number;
  bbrState?: number;
  bbrBandwidth?: number;
  bytesTransmitted?: number;
  packetsTransmitted?: number;
  bytesReceived?: number;
  packetsReceived?: number;
  packetsDroppedByKernel?: number;
}

export interface DesktopDiagnosticTransportSnapshot {
  isInitiator?: boolean;
  connected?: boolean;
  destroying?: boolean;
  destroyed?: boolean;
  publicKey?: string;
  remotePublicKey?: string;
  udx?: DesktopDiagnosticUdxSnapshot;
}

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
  transport?: DesktopDiagnosticTransportSnapshot;
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
  | DesktopDiagnosticTransportEvent
  | DesktopDiagnosticDeviceObservation;

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
  if (source.includes("exceeds") || source.includes("64 kib") || source.includes("size")) {
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

export function serializeDesktopDiagnosticEvent(
  value: unknown,
): string {
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

export interface DesktopDiagnosticFileSystem {
  mkdir(
    directory: string,
    options?: { mode?: number; recursive?: boolean },
  ): Promise<void>;
  readFile(filePath: string, encoding: "utf8"): Promise<string>;
  appendFile(filePath: string, contents: string): Promise<void>;
  rename(sourcePath: string, destinationPath: string): Promise<void>;
  rm(filePath: string, options?: { force?: boolean }): Promise<void>;
  stat(filePath: string): Promise<{ size: number }>;
}

const defaultFileSystem: DesktopDiagnosticFileSystem = {
  mkdir: async (directory, options) => {
    await mkdir(directory, options);
  },
  readFile,
  appendFile,
  rename,
  rm,
  stat,
};

export interface DesktopDiagnosticRoleSummary {
  phase: "starting" | "running" | "failed" | "stopping" | "stopped";
  serviceCount?: number;
  activeSubscribers?: number;
  acceptedConnections?: number;
  connection?:
    | "unconfigured"
    | "connecting"
    | "connected"
    | "reconnecting"
    | "stopped";
}

export interface DesktopDiagnosticSink {
  readonly directory?: string;
  readonly ready: Promise<void>;
  observe(observation: DesktopDiagnosticObservation): void;
  updateSnapshot(snapshot: DesktopSnapshot): void;
  createSummary(maxBytes?: number): Promise<string>;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
  droppedEventCount(): number;
}

export interface CreateDesktopDiagnosticSinkOptions {
  directory: string;
  platform?: string;
  fileSystem?: DesktopDiagnosticFileSystem;
}

interface RetainedRecord {
  event: DesktopDiagnosticEvent;
  line: string;
  bytes: number;
}

interface QueuedRecord extends RetainedRecord {}

export function createDesktopDiagnosticSink(
  options: CreateDesktopDiagnosticSinkOptions,
): DesktopDiagnosticSink {
  const fileSystem = options.fileSystem ?? defaultFileSystem;
  const platform = normalizePlatform(options.platform ?? process.platform);
  const filePaths = diagnosticFileNames.map((name) =>
    path.join(options.directory, name),
  );
  const fileRecords: RetainedRecord[][] = [[], [], [], []];
  const roles: {
    publisher?: DesktopDiagnosticRoleSummary;
    subscriber?: DesktopDiagnosticRoleSummary;
  } = {};
  let activeBytes = 0;
  let initializationError: DesktopDiagnosticErrorCategory | undefined;
  let droppedEvents = 0;
  let accepting = true;
  let queue: QueuedRecord[] = [];
  let activeWrite: Promise<void> | undefined;
  let shutdownTask: Promise<void> | undefined;

  const ready = initialize();

  async function initialize(): Promise<void> {
    try {
      await fileSystem.mkdir(options.directory, {
        mode: 0o700,
        recursive: true,
      });
    } catch (error) {
      initializationError = desktopDiagnosticErrorCategory(error);
      return;
    }

    for (let index = diagnosticFileNames.length - 1; index >= 0; index -= 1) {
      try {
        const source = await fileSystem.readFile(filePaths[index]!, "utf8");
        fileRecords[index]!.push(...parseRetainedRecords(source));
        if (index === 0) activeBytes = b4a.byteLength(source, "utf8");
      } catch (error) {
        if (!isMissingFile(error)) {
          initializationError ??= desktopDiagnosticErrorCategory(error);
        }
      }
    }

    if (activeBytes === 0) {
      try {
        activeBytes = Math.max(0, (await fileSystem.stat(filePaths[0]!)).size);
      } catch (error) {
        if (!isMissingFile(error)) {
          initializationError ??= desktopDiagnosticErrorCategory(error);
        }
      }
    }
  }

  function observe(observation: DesktopDiagnosticObservation): void {
    if (!accepting) {
      droppedEvents++;
      return;
    }
    let record: QueuedRecord;
    try {
      const line = serializeDesktopDiagnosticEvent(observation);
      const event = normalizeDesktopDiagnosticEvent(observation);
      if (!event) throw new Error("desktop diagnostic event is invalid");
      const bytes = b4a.byteLength(line, "utf8") + 1;
      if (bytes > DESKTOP_DIAGNOSTIC_EVENT_MAX_BYTES) {
        throw new Error("desktop diagnostic event exceeds 8 KiB");
      }
      record = { event, line, bytes };
    } catch {
      droppedEvents++;
      return;
    }
    if (queue.length >= DESKTOP_DIAGNOSTIC_QUEUE_LIMIT) {
      droppedEvents++;
      return;
    }
    queue.push(record);
    drain();
  }

  function updateSnapshot(snapshot: DesktopSnapshot): void {
    const nextPublisher = snapshot.publisher;
    if (nextPublisher) {
      roles.publisher = {
        phase: normalizeRolePhase(nextPublisher.phase),
        serviceCount: boundedArrayLength(nextPublisher.services),
        activeSubscribers: boundedCount(nextPublisher.activeSubscribers) ?? 0,
        acceptedConnections: boundedCount(nextPublisher.acceptedConnections) ?? 0,
      };
    } else {
      delete roles.publisher;
    }

    const nextSubscriber = snapshot.subscriber;
    if (nextSubscriber) {
      roles.subscriber = {
        phase: normalizeRolePhase(nextSubscriber.phase),
        connection: normalizeConnection(nextSubscriber.connection),
        serviceCount: boundedArrayLength(nextSubscriber.services),
      };
    } else {
      delete roles.subscriber;
    }
  }

  function drain(): void {
    if (!accepting || activeWrite !== undefined) return;
    const next = queue.shift();
    if (!next) return;
    const task = writeRecord(next).catch(() => {
      droppedEvents++;
    });
    activeWrite = task;
    void task.then(() => {
      if (activeWrite === task) activeWrite = undefined;
      drain();
    });
  }

  async function writeRecord(record: QueuedRecord): Promise<void> {
    await ready;
    if (initializationError !== undefined) throw new Error("diagnostic write unavailable");
    if (activeBytes + record.bytes > DESKTOP_DIAGNOSTIC_ACTIVE_MAX_BYTES) {
      await rotateFiles();
    }
    await fileSystem.appendFile(filePaths[0]!, `${record.line}\n`);
    activeBytes += record.bytes;
    fileRecords[0]!.push(record);
  }

  async function rotateFiles(): Promise<void> {
    await fileSystem.rm(filePaths[3]!, { force: true });
    await moveIfPresent(fileSystem, filePaths[2]!, filePaths[3]!);
    await moveIfPresent(fileSystem, filePaths[1]!, filePaths[2]!);
    await moveIfPresent(fileSystem, filePaths[0]!, filePaths[1]!);
    fileRecords[3] = fileRecords[2]!;
    fileRecords[2] = fileRecords[1]!;
    fileRecords[1] = fileRecords[0]!;
    fileRecords[0] = [];
    activeBytes = 0;
  }

  async function flush(): Promise<void> {
    await ready;
    while (queue.length > 0 || activeWrite !== undefined) {
      drain();
      const write = activeWrite;
      if (write) {
        await write;
      } else {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
  }

  async function createSummary(maxBytes = DESKTOP_DIAGNOSTIC_SUMMARY_MAX_BYTES): Promise<string> {
    await ready;
    if (initializationError !== undefined) {
      throw new Error("diagnostic read unavailable");
    }
    const summaryLimit = Math.min(
      DESKTOP_DIAGNOSTIC_SUMMARY_MAX_BYTES,
      Math.max(1, maxBytes),
    );
    const base = {
      platform,
      droppedEvents,
      roles: {
        ...(roles.publisher ? { publisher: { ...roles.publisher } } : {}),
        ...(roles.subscriber ? { subscriber: { ...roles.subscriber } } : {}),
      },
      events: [] as DesktopDiagnosticEvent[],
    };
    const retained = [...fileRecords].reverse().flat();
    const selected: DesktopDiagnosticEvent[] = [];
    for (
      let index = retained.length - 1;
      index >= 0 && selected.length < DESKTOP_DIAGNOSTIC_SUMMARY_MAX_EVENTS;
      index -= 1
    ) {
      const candidate = [retained[index]!.event, ...selected];
      const serialized = JSON.stringify({ ...base, events: candidate });
      if (b4a.byteLength(serialized, "utf8") <= summaryLimit) {
        selected.unshift(retained[index]!.event);
      }
    }
    const summary = JSON.stringify({ ...base, events: selected });
    if (b4a.byteLength(summary, "utf8") > summaryLimit) {
      throw new Error("desktop diagnostic summary exceeds 64 KiB");
    }
    return summary;
  }

  async function shutdown(): Promise<void> {
    shutdownTask ??= (async () => {
      accepting = false;
      droppedEvents += queue.length;
      queue = [];
      const write = activeWrite;
      if (!write) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        write,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, DESKTOP_DIAGNOSTIC_SHUTDOWN_TIMEOUT_MS);
        }),
      ]);
      if (timer !== undefined) clearTimeout(timer);
    })();
    await shutdownTask;
  }

  return {
    directory: options.directory,
    ready,
    observe,
    updateSnapshot,
    createSummary,
    flush,
    shutdown,
    droppedEventCount: () => droppedEvents,
  };
}

export function createNoopDesktopDiagnosticSink(
  platform: string = process.platform,
): DesktopDiagnosticSink {
  platform = normalizePlatform(platform);
  let droppedEvents = 0;
  const roles: {
    publisher?: DesktopDiagnosticRoleSummary;
    subscriber?: DesktopDiagnosticRoleSummary;
  } = {};
  return {
    ready: Promise.resolve(),
    observe: () => undefined,
    updateSnapshot(snapshot): void {
      if (snapshot.publisher) {
        roles.publisher = {
          phase: normalizeRolePhase(snapshot.publisher.phase),
          serviceCount: boundedArrayLength(snapshot.publisher.services),
          activeSubscribers: boundedCount(snapshot.publisher.activeSubscribers) ?? 0,
          acceptedConnections: boundedCount(snapshot.publisher.acceptedConnections) ?? 0,
        };
      }
      if (snapshot.subscriber) {
        roles.subscriber = {
          phase: normalizeRolePhase(snapshot.subscriber.phase),
          connection: normalizeConnection(snapshot.subscriber.connection),
          serviceCount: boundedArrayLength(snapshot.subscriber.services),
        };
      }
    },
    async createSummary(): Promise<string> {
      return JSON.stringify({
        platform,
        droppedEvents,
        roles,
        events: [],
      });
    },
    flush: async () => undefined,
    shutdown: async () => undefined,
    droppedEventCount: () => droppedEvents,
  };
}

function normalizeDeviceEvent(
  value: Record<string, unknown>,
): DesktopDiagnosticDeviceObservation | undefined {
  const timestamp = normalizeTimestamp(value.timestamp);
  if (!timestamp || value.source !== "device") return undefined;

  if (value.event === "desktop.lifecycle") {
    if (!isLifecyclePhase(value.phase)) return undefined;
    return { source: "device", timestamp, event: value.event, phase: value.phase };
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
  if (typeof value.serviceId === "string" && serviceIdPattern.test(value.serviceId)) {
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
  const transport = normalizeTransportSnapshot(value.transport);
  if (transport) output.transport = transport;
  const dht = normalizeDhtCounters(value.dht);
  if (dht) output.dht = dht;
  return output as unknown as DesktopDiagnosticTransportEvent;
}

function normalizeTransportSnapshot(
  value: unknown,
): DesktopDiagnosticTransportSnapshot | undefined {
  if (!isRecord(value)) return undefined;
  const output: Record<string, unknown> = {};
  for (const field of ["isInitiator", "connected", "destroying", "destroyed"] as const) {
    if (typeof value[field] === "boolean") output[field] = value[field];
  }
  const publicKey = normalizeFingerprint(value.publicKey);
  const remotePublicKey = normalizeFingerprint(value.remotePublicKey);
  if (publicKey) output.publicKey = publicKey;
  if (remotePublicKey) output.remotePublicKey = remotePublicKey;
  const udx = normalizeNumberRecord(value.udx, udxNumberFields);
  if (udx) output.udx = udx;
  return Object.keys(output).length > 0
    ? (output as DesktopDiagnosticTransportSnapshot)
    : undefined;
}

function normalizeDhtCounters(value: unknown): DesktopDiagnosticDhtCounters | undefined {
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

function parseRetainedRecords(source: string): RetainedRecord[] {
  const boundedSource =
    b4a.byteLength(source, "utf8") > DESKTOP_DIAGNOSTIC_ACTIVE_MAX_BYTES
      ? source.slice(-DESKTOP_DIAGNOSTIC_ACTIVE_MAX_BYTES)
      : source;
  const records: RetainedRecord[] = [];
  for (const line of boundedSource.split(/\r?\n/)) {
    if (!line) continue;
    try {
      const value: unknown = JSON.parse(line);
      const event = normalizeDesktopDiagnosticEvent(value);
      if (!event) continue;
      const serialized = serializeDesktopDiagnosticEvent(event);
      records.push({
        event,
        line: serialized,
        bytes: b4a.byteLength(serialized, "utf8") + 1,
      });
    } catch {
      // A truncated, malformed, or obsolete line is not copied forward.
    }
  }
  return records;
}

async function moveIfPresent(
  fileSystem: DesktopDiagnosticFileSystem,
  sourcePath: string,
  destinationPath: string,
): Promise<void> {
  try {
    await fileSystem.rename(sourcePath, destinationPath);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
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

function boundedArrayLength(value: unknown): number {
  return Array.isArray(value)
    ? Math.min(value.length, maximumDiagnosticNumber)
    : 0;
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
  return typeof value === "string" && observationRoles.has(value as ObservationRole)
    ? (value as ObservationRole)
    : undefined;
}

function normalizeObservationName(value: unknown): ObservationName | undefined {
  return typeof value === "string" && observationNames.has(value as ObservationName)
    ? (value as ObservationName)
    : undefined;
}

function normalizeRolePhase(
  value: unknown,
): DesktopDiagnosticRoleSummary["phase"] {
  return value === "starting" ||
    value === "running" ||
    value === "failed" ||
    value === "stopping" ||
    value === "stopped"
    ? value
    : "failed";
}

function normalizeConnection(
  value: unknown,
): NonNullable<DesktopDiagnosticRoleSummary["connection"]> {
  return value === "unconfigured" ||
    value === "connecting" ||
    value === "connected" ||
    value === "reconnecting" ||
    value === "stopped"
    ? value
    : "stopped";
}

function normalizeErrorCategory(
  value: unknown,
): DesktopDiagnosticErrorCategory | undefined {
  return typeof value === "string" &&
    diagnosticErrorCategories.has(value as DesktopDiagnosticErrorCategory)
    ? (value as DesktopDiagnosticErrorCategory)
    : undefined;
}

function isLifecyclePhase(
  value: unknown,
): value is DesktopDiagnosticLifecyclePhase {
  return value === "starting" ||
    value === "running" ||
    value === "stopping" ||
    value === "stopped";
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizePlatform(value: string): string {
  return value === "darwin" ||
    value === "win32" ||
    value === "linux" ||
    value === "freebsd" ||
    value === "openbsd" ||
    value === "aix" ||
    value === "sunos" ||
    value === "android"
    ? value
    : "unknown";
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}