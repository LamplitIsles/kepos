import * as b4a from "b4a";

import type {
  DesktopConnection,
  DesktopSnapshot,
} from "./protocol.js";

const maximumMessageBytes = 64 * 1024;
const smokeRenderMessageType = "windows-smoke-rendered" as const;
const connections: readonly DesktopConnection[] = [
  "unconfigured",
  "connecting",
  "connected",
  "reconnecting",
  "stopped",
];

export interface DesktopSmokeRenderAcknowledgement {
  type: typeof smokeRenderMessageType;
  role?: "peer";
  connection: DesktopConnection;
  serviceCount: number;
  subscriberKeyPresent: boolean;
  peerKeyPresent?: boolean;
  connectFormVisible: boolean;
}

export function isHealthySmokeSnapshot(
  snapshot: DesktopSnapshot | undefined,
): snapshot is DesktopSnapshot {
  if (!snapshot || snapshot.appPhase !== "running") return false;
  if (snapshot.publisher && snapshot.publisher.phase !== "running") return false;
  if (snapshot.subscriber && snapshot.subscriber.phase !== "running") return false;
  if (snapshot.peer && snapshot.peer.phase !== "running") return false;
  return Boolean(snapshot.publisher || snapshot.subscriber || snapshot.peer);
}

export function isHealthyUnconfiguredSmokeSnapshot(
  snapshot: DesktopSnapshot | undefined,
): snapshot is DesktopSnapshot {
  if (!isHealthySmokeSnapshot(snapshot)) return false;
  if (snapshot.peer) {
    return typeof snapshot.peer.peerKey === "string" && snapshot.peer.peerKey.length > 0;
  }
  return Boolean(
    snapshot.subscriber &&
      snapshot.subscriber.phase === "running" &&
      snapshot.subscriber.connection === "unconfigured" &&
      typeof snapshot.subscriber.subscriberKey === "string" &&
      snapshot.subscriber.subscriberKey.length > 0,
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
    "subscriberKeyPresent",
    "peerKeyPresent",
    "connectFormVisible",
  ]);
  if (value.role !== undefined && value.role !== "peer") {
    throw new Error("desktop smoke acknowledgement role is invalid");
  }
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
  if (typeof value.subscriberKeyPresent !== "boolean") {
    throw new Error(
      "desktop smoke acknowledgement subscriber key presence is invalid",
    );
  }
  if (value.role === "peer" && typeof value.peerKeyPresent !== "boolean") {
    throw new Error("desktop smoke acknowledgement peer key presence is invalid");
  }
  if (value.role !== "peer" && value.peerKeyPresent !== undefined) {
    throw new Error("desktop smoke acknowledgement peer key field is unexpected");
  }
  if (typeof value.connectFormVisible !== "boolean") {
    throw new Error(
      "desktop smoke acknowledgement connect form visibility is invalid",
    );
  }

  return {
    type: smokeRenderMessageType,
    ...(value.role === "peer" ? { role: "peer" as const } : {}),
    connection: value.connection as DesktopConnection,
    serviceCount: value.serviceCount,
    subscriberKeyPresent: value.subscriberKeyPresent,
    ...(value.role === "peer"
      ? { peerKeyPresent: value.peerKeyPresent as boolean }
      : {}),
    connectFormVisible: value.connectFormVisible,
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
  if (unknown) {
    throw new Error(`desktop smoke acknowledgement has unknown field: ${unknown}`);
  }
}
