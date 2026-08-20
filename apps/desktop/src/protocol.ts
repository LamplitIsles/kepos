import type { DesktopDiagnosticErrorCategory } from "./diagnostics.js";

export type DesktopConnection =
  | "unconfigured"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "stopped";

export interface DesktopService {
  id: string;
  name: string;
  access: "http" | "ssh" | "tcp";
  action: "open" | "copy-command" | "copy-url";
  icon:
    | "book"
    | "build"
    | "dashboard"
    | "dagger"
    | "git"
    | "music"
    | "photos"
    | "port"
    | "proxy"
    | "storage"
    | "terminal"
    | "web";
  available: boolean;
  copyText?: string;
  url?: string;
}

export type RolePhase =
  | "starting"
  | "running"
  | "failed"
  | "stopping"
  | "stopped";

export interface DesktopSubscriberRole {
  phase: RolePhase;
  connection: DesktopConnection;
  subscriberKey?: string;
  remotePublisher?: {
    displayName: string;
    publisherKey: string;
    keyFingerprint: string;
  };
  gatewayPort?: number;
  services: DesktopService[];
  connectionHint?: "udp-firewall-vpn-tun";
  error?: string;
}

export interface DesktopPublisherRole {
  phase: RolePhase;
  displayName?: string;
  publisherKey?: string;
  keyFingerprint?: string;
  activeSubscribers: number;
  activeSubscriberKeys: string[];
  acceptedConnections: number;
  services: Array<{ id: string; name: string; targetPort: number }>;
  pairing?:
    | { phase: "idle" }
    | {
        phase: "inviting";
        expiresAt: number;
        expired: boolean;
        qrSvg?: string;
      }
    | {
        phase: "pending";
        subscriberKey: string;
        keyFingerprint: string;
        label: string;
        platform: string;
        error?: string;
      };
  error?: string;
}

export interface DesktopSnapshot {
  type: "snapshot";
  appPhase: "starting" | "running" | "stopping" | "stopped";
  subscriber?: DesktopSubscriberRole;
  publisher?: DesktopPublisherRole;
}

export type DesktopCommand =
  | { type: "ready" }
  | { type: "openService"; serviceId: string }
  | { type: "copyDiagnostics" }
  | { type: "createPairingInvitation" }
  | { type: "cancelPairing" }
  | { type: "approvePairing" }
  | { type: "denyPairing" }
  | { type: "setSubscriberPublisher"; publisherKey: string }
  | { type: "quit" };

export type DesktopDiagnosticsResult =
  | { type: "diagnosticsResult"; ok: true; summary: string }
  | {
      type: "diagnosticsResult";
      ok: false;
      errorCategory: DesktopDiagnosticErrorCategory;
    };

export function parseDesktopCommand(source: string): DesktopCommand {
  if (b4a.byteLength(source, "utf8") > maximumMessageBytes) {
    throw new Error("desktop command exceeds 64 KiB");
  }

  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error("desktop command is not valid JSON", { cause: error });
  }
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new Error("desktop command must be an object with a type");
  }

  if (value.type === "openService") {
    rejectUnknownFields(value, ["type", "serviceId"]);
    if (
      typeof value.serviceId !== "string" ||
      !serviceIdPattern.test(value.serviceId)
    ) {
      throw new Error("desktop command service id is invalid");
    }
    return { type: "openService", serviceId: value.serviceId };
  }

  if (value.type === "setSubscriberPublisher") {
    rejectUnknownFields(value, ["type", "publisherKey"]);
    if (
      typeof value.publisherKey !== "string" ||
      !publisherKeyPattern.test(value.publisherKey)
    ) {
      throw new Error("desktop command publisher key is invalid");
    }
    return { type: "setSubscriberPublisher", publisherKey: value.publisherKey };
  }

  if (
    value.type === "ready" ||
    value.type === "quit" ||
    value.type === "copyDiagnostics" ||
    value.type === "createPairingInvitation" ||
    value.type === "cancelPairing" ||
    value.type === "approvePairing" ||
    value.type === "denyPairing"
  ) {
    rejectUnknownFields(value, ["type"]);
    return { type: value.type };
  }

  throw new Error(`unsupported desktop command: ${value.type}`);
}

export function serializeDesktopSnapshot(snapshot: DesktopSnapshot): string {
  return JSON.stringify(snapshot);
}

export function serializeDesktopDiagnosticsResult(
  result: DesktopDiagnosticsResult,
): string {
  let serialized: string;
  if (result.ok) {
    if (typeof result.summary !== "string") {
      throw new Error("diagnostics result summary is invalid");
    }
    serialized = JSON.stringify({
      type: "diagnosticsResult",
      ok: true,
      summary: result.summary,
    });
  } else {
    if (!diagnosticErrorCategories.has(result.errorCategory)) {
      throw new Error("diagnostics result error category is invalid");
    }
    serialized = JSON.stringify({
      type: "diagnosticsResult",
      ok: false,
      errorCategory: result.errorCategory,
    });
  }
  if (b4a.byteLength(serialized, "utf8") > maximumMessageBytes) {
    throw new Error("diagnostics result exceeds 64 KiB");
  }
  return serialized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnknownFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const allowedFields = new Set(allowed);
  const unknown = Object.keys(value).find((field) => !allowedFields.has(field));
  if (unknown) throw new Error(`desktop command has unknown field: ${unknown}`);
}
import * as b4a from "b4a";

const maximumMessageBytes = 64 * 1024;
const diagnosticErrorCategories = new Set([
  "unknown",
  "timeout",
  "permission",
  "not-found",
  "invalid",
  "conflict",
  "unavailable",
  "size",
]);
const serviceIdPattern = /^[a-z][a-z0-9-]*$/;
const publisherKeyPattern = /^[0-9a-f]{64}$/;
