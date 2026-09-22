import * as b4a from "b4a";

import type { PeerBinding, PeerServiceSource } from "../../../src/config.js";
import type {
  ServiceAction,
  ServiceIcon,
} from "../../../src/services/presentation.js";
import {
  isDesktopDiagnosticErrorCategory,
  type DesktopDiagnosticErrorCategory,
} from "./diagnostics-contract.js";

const maximumMessageBytes = 64 * 1024;
const serviceIdPattern = /^[a-z][a-z0-9-]*$/u;

export type DesktopConnection =
  | "unconfigured"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "stopped";

export type RolePhase =
  | "starting"
  | "running"
  | "failed"
  | "stopping"
  | "stopped";

export interface DesktopPeerRole {
  phase: RolePhase;
  peerKey?: string;
  gatewayPort?: number;
  connections: Array<{
    label: string;
    publicKey: string;
    connection: "dial" | "accept";
    status: string;
    generation: number;
    services: number;
    error?: string;
  }>;
  services: Array<{
    id: string;
    name: string;
    kind: "tcp" | "http" | "udp";
    source: PeerServiceSource;
    available: boolean;
    access?: "http" | "ssh" | "tcp" | "udp";
    action?: ServiceAction;
    icon?: ServiceIcon;
    url?: string;
    copyText?: string;
    peer?: string;
    error?: string;
  }>;
  bindings: Array<{
    peer: string;
    service: string;
    listen: PeerBinding["listen"];
    kind?: "tcp" | "udp";
    port?: number;
    available: boolean;
    error?: string;
  }>;
  pairing?: DesktopPairingSnapshot;
  error?: string;
}

export type DesktopPairingSnapshot =
  | { phase: "idle" }
  | {
      phase: "inviting";
      expiresAt: number;
      expired: boolean;
      uri?: string;
      qrSvg?: string;
    }
  | {
      phase: "pending";
      peerKey: string;
      keyFingerprint: string;
      label: string;
      platform: string;
    };

export interface DesktopSnapshot {
  type: "snapshot";
  appPhase: "starting" | "running" | "stopping" | "stopped";
  peer?: DesktopPeerRole;
}

export type DesktopCommand =
  | { type: "ready" }
  | { type: "openService"; serviceId: string }
  | { type: "copyDiagnostics" }
  | { type: "createPairingInvitation" }
  | { type: "cancelPairing" }
  | { type: "approvePairing" }
  | { type: "denyPairing" }
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
    if (!isDesktopDiagnosticErrorCategory(result.errorCategory)) {
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
