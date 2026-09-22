import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import type { DesktopSnapshot } from "./protocol.js";

export const DESKTOP_FATAL_FILE = "fatal.json";
export const DESKTOP_FATAL_MAX_BYTES = 16 * 1024;

export interface DesktopFatalRecord {
  timestamp: string;
  runId: string;
  pid?: number;
  uptimeMs?: number;
  runtimeVersion?: string;
  kind: "uncaughtException" | "unhandledRejection" | "startup";
  name: string;
  code?: string;
  message: string;
  stack?: string;
  peer?: {
    phase: string;
    connections: number;
    services: number;
    bindings: number;
  };
}

export interface DesktopFatalCaptureOptions {
  directory: string;
  runId: string;
  snapshot: () => DesktopSnapshot | undefined;
  exit: (code: number) => void;
}

export function installDesktopFatalCapture(
  options: DesktopFatalCaptureOptions,
): (kind: DesktopFatalRecord["kind"], error: unknown) => void {
  let handling = false;
  const capture = (kind: DesktopFatalRecord["kind"], error: unknown): void => {
    if (!handling) {
      handling = true;
      persistDesktopFatal(
        options.directory,
        options.runId,
        kind,
        error,
        options.snapshot(),
      );
    }
    options.exit(1);
  };
  const bareRuntime = (
    globalThis as unknown as {
      Bare?: {
        on?: (event: string, listener: (error: unknown) => void) => void;
      };
    }
  ).Bare;
  bareRuntime?.on?.("uncaughtException", (error) =>
    capture("uncaughtException", error),
  );
  bareRuntime?.on?.("unhandledRejection", (error) =>
    capture("unhandledRejection", error),
  );
  process.on("uncaughtException", (error) =>
    capture("uncaughtException", error),
  );
  process.on("unhandledRejection", (error) =>
    capture("unhandledRejection", error),
  );
  return capture;
}

export function persistDesktopFatal(
  directory: string,
  runId: string,
  kind: DesktopFatalRecord["kind"],
  error: unknown,
  snapshot?: DesktopSnapshot,
): void {
  const target = path.join(directory, DESKTOP_FATAL_FILE);
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(
      `${target}.tmp`,
      boundedJson(fatalRecord(runId, kind, error, snapshot)),
      {
        mode: 0o600,
      },
    );
    renameSync(`${target}.tmp`, target);
  } catch {
    // Fatal capture is best effort. The caller still exits.
  }
}

export function fatalRecord(
  runId: string,
  kind: DesktopFatalRecord["kind"],
  error: unknown,
  snapshot?: DesktopSnapshot,
): DesktopFatalRecord {
  const source = error instanceof Error ? error : new Error(String(error));
  const raw =
    error && typeof error === "object" && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
  const code =
    typeof raw === "string" && /^[A-Z][A-Z0-9_]{0,31}$/u.test(raw)
      ? raw
      : undefined;
  const peer = snapshot?.peer;
  return {
    timestamp: new Date().toISOString(),
    runId,
    ...(typeof process.pid === "number" ? { pid: process.pid } : {}),
    ...(typeof process.uptime === "function"
      ? { uptimeMs: Math.round(process.uptime() * 1000) }
      : {}),
    ...(typeof process.version === "string"
      ? { runtimeVersion: redact(process.version, 128) }
      : {}),
    kind,
    name: redact(source.name || "Error", 128),
    ...(code ? { code } : {}),
    message: redact(source.message || String(error), 4096),
    ...(source.stack ? { stack: redact(source.stack, 8192) } : {}),
    ...(peer
      ? {
          peer: {
            phase: peer.phase,
            connections: peer.connections.length,
            services: peer.services.length,
            bindings: peer.bindings.length,
          },
        }
      : {}),
  };
}

function boundedJson(record: DesktopFatalRecord): string {
  let text = JSON.stringify(record);
  if (Buffer.byteLength(text, "utf8") <= DESKTOP_FATAL_MAX_BYTES) return text;
  record.stack = undefined;
  record.message = record.message.slice(0, 1024);
  return JSON.stringify(record).slice(0, DESKTOP_FATAL_MAX_BYTES);
}

export function redact(value: string, limit: number): string {
  return value
    .replace(
      /authorization\s*:\s*bearer\s+[^\s,]+/giu,
      "authorization=[redacted]",
    )
    .replace(/\bbearer\s+(?!\[redacted\])[^\s,]+/giu, "Bearer [redacted]")
    .replace(
      /(authorization|bearer|token|secret|seed|password)\s*[:=]\s*[^\s,]+/giu,
      "$1=[redacted]",
    )
    .replace(/\b[0-9a-f]{64}\b/giu, "[redacted-identity]")
    .replace(/https?:\/\/[^\s)]+/giu, "[redacted-url]")
    .replace(
      /(?:\/Users\/[^\s:]+|\/home\/[^\s:]+|[A-Z]:\\Users\\[^\s:]+)/gu,
      "[redacted-home]",
    )
    .slice(0, limit);
}
