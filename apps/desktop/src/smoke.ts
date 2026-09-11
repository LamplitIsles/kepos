import * as b4a from "b4a";

import type { DesktopConnection, DesktopSnapshot } from "./protocol.js";

const maximumMessageBytes = 64 * 1024;
const smokeRenderMessageType = "windows-smoke-rendered" as const;
const connections: readonly DesktopConnection[] = [
  "connecting",
  "connected",
  "reconnecting",
  "stopped",
];

export interface DesktopSmokeRenderAcknowledgement {
  type: typeof smokeRenderMessageType;
  role: "peer";
  connection: DesktopConnection;
  serviceCount: number;
  peerKeyPresent: boolean;
  connectFormVisible: false;
}

export function isHealthySmokeSnapshot(
  snapshot: DesktopSnapshot | undefined,
): snapshot is DesktopSnapshot {
  return Boolean(
    snapshot &&
      snapshot.appPhase === "running" &&
      snapshot.peer &&
      snapshot.peer.phase === "running" &&
      typeof snapshot.peer.peerKey === "string" &&
      snapshot.peer.peerKey.length > 0,
  );
}

export function parseDesktopSmokeRenderAcknowledgement(
  source: string,
): DesktopSmokeRenderAcknowledgement | undefined {
  if (b4a.byteLength(source, "utf8") > maximumMessageBytes) {
    throw new Error("desktop smoke acknowledgement exceeds 64 KiB");
  }
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error("desktop smoke acknowledgement is not valid JSON", {
      cause: error,
    });
  }
  if (!isRecord(value) || value.type !== smokeRenderMessageType) return undefined;
  rejectUnknownFields(value, [
    "type",
    "role",
    "connection",
    "serviceCount",
    "peerKeyPresent",
    "connectFormVisible",
  ]);
  if (value.role !== "peer") throw new Error("desktop smoke acknowledgement role is invalid");
  if (
    typeof value.connection !== "string" ||
    !connections.includes(value.connection as DesktopConnection)
  ) {
    throw new Error("desktop smoke acknowledgement connection is invalid");
  }
  if (
    typeof value.serviceCount !== "number" ||
    !Number.isSafeInteger(value.serviceCount) ||
    value.serviceCount < 0
  ) {
    throw new Error("desktop smoke acknowledgement service count is invalid");
  }
  if (typeof value.peerKeyPresent !== "boolean") {
    throw new Error("desktop smoke acknowledgement peer key presence is invalid");
  }
  if (value.connectFormVisible !== false) {
    throw new Error("desktop smoke acknowledgement connect form must be hidden");
  }
  return {
    type: smokeRenderMessageType,
    role: "peer",
    connection: value.connection as DesktopConnection,
    serviceCount: value.serviceCount,
    peerKeyPresent: value.peerKeyPresent,
    connectFormVisible: false,
  };
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
  if (unknown) throw new Error(`desktop smoke acknowledgement has unknown field: ${unknown}`);
}
