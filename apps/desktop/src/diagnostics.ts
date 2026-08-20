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

import type { DesktopSnapshot } from "./protocol.js";
import {
  DESKTOP_DIAGNOSTIC_EVENT_MAX_BYTES,
  desktopDiagnosticErrorCategory,
  normalizeDesktopDiagnosticEvent,
  serializeDesktopDiagnosticEvent,
  type DesktopDiagnosticErrorCategory,
  type DesktopDiagnosticEvent,
  type DesktopDiagnosticObservation,
} from "./diagnostics-contract.js";

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
    "unconfigured" | "connecting" | "connected" | "reconnecting" | "stopped";
}

interface DesktopDiagnosticRoleSummaries {
  publisher?: DesktopDiagnosticRoleSummary;
  subscriber?: DesktopDiagnosticRoleSummary;
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

type QueuedRecord = RetainedRecord;

export function createDesktopDiagnosticSink(
  options: CreateDesktopDiagnosticSinkOptions,
): DesktopDiagnosticSink {
  const fileSystem = options.fileSystem ?? defaultFileSystem;
  const platform = normalizePlatform(options.platform ?? process.platform);
  const filePaths = diagnosticFileNames.map((name) =>
    path.join(options.directory, name),
  );
  const fileRecords: RetainedRecord[][] = [[], [], [], []];
  const roles: DesktopDiagnosticRoleSummaries = {};
  let activeBytes = 0;
  let initializationError: DesktopDiagnosticErrorCategory | undefined;
  let droppedEvents = 0;
  let accepting = true;
  let queue: QueuedRecord[] = [];
  let activeWrite: Promise<void> | undefined;
  let activeRecord: QueuedRecord | undefined;
  let activeRecordPersisted = false;
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
    updateRoleSummaries(roles, snapshot);
  }

  function drain(): void {
    if (!accepting || activeWrite !== undefined) return;
    const next = queue.shift();
    if (!next) return;
    activeRecord = next;
    activeRecordPersisted = false;
    const task = writeRecord(next).catch(() => {
      droppedEvents++;
    });
    activeWrite = task;
    void task.then(() => {
      if (activeWrite === task) {
        activeWrite = undefined;
        activeRecord = undefined;
        activeRecordPersisted = false;
      }
      drain();
    });
  }

  async function writeRecord(record: QueuedRecord): Promise<void> {
    await ready;
    if (initializationError !== undefined) {
      throw new Error("diagnostic write unavailable");
    }
    if (activeBytes + record.bytes > DESKTOP_DIAGNOSTIC_ACTIVE_MAX_BYTES) {
      await rotateFiles();
    }
    await fileSystem.appendFile(filePaths[0]!, `${record.line}\n`);
    activeBytes += record.bytes;
    fileRecords[0]!.push(record);
    activeRecordPersisted = true;
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

  async function createSummary(
    maxBytes = DESKTOP_DIAGNOSTIC_SUMMARY_MAX_BYTES,
  ): Promise<string> {
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
    const retained = recordsForSummary(
      fileRecords,
      activeRecord,
      activeRecordPersisted,
      queue,
    );
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
  const roles: DesktopDiagnosticRoleSummaries = {};
  return {
    ready: Promise.resolve(),
    observe: () => undefined,
    updateSnapshot(snapshot): void {
      updateRoleSummaries(roles, snapshot);
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

function updateRoleSummaries(
  roles: DesktopDiagnosticRoleSummaries,
  snapshot: DesktopSnapshot,
): void {
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

function recordsForSummary(
  fileRecords: RetainedRecord[][],
  activeRecord: QueuedRecord | undefined,
  activeRecordPersisted: boolean,
  queue: QueuedRecord[],
): RetainedRecord[] {
  const retained = [...fileRecords].reverse().flat();
  if (activeRecord && !activeRecordPersisted) retained.push(activeRecord);
  retained.push(...queue);
  return retained;
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

function boundedNumber(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 1_000_000_000_000
    ? value
    : undefined;
}

function boundedCount(value: unknown): number | undefined {
  return boundedNumber(value);
}

function boundedArrayLength(value: unknown): number {
  return Array.isArray(value) ? Math.min(value.length, 1_000_000_000_000) : 0;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
