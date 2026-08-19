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
  connection: DesktopConnection;
  serviceCount: number;
  subscriberKeyPresent: boolean;
  connectFormVisible: boolean;
}

export function isHealthySmokeSnapshot(
  snapshot: DesktopSnapshot | undefined,
): snapshot is DesktopSnapshot {
  if (!snapshot || snapshot.appPhase !== "running") return false;
  if (snapshot.publisher && snapshot.publisher.phase !== "running") return false;
  if (snapshot.subscriber && snapshot.subscriber.phase !== "running") return false;
  return Boolean(snapshot.publisher || snapshot.subscriber);
}

export function isHealthyUnconfiguredSmokeSnapshot(
  snapshot: DesktopSnapshot | undefined,
): snapshot is DesktopSnapshot & {
  subscriber: NonNullable<DesktopSnapshot["subscriber"]>;
} {
  return (
    isHealthySmokeSnapshot(snapshot) &&
    snapshot.subscriber !== undefined &&
    snapshot.subscriber.phase === "running" &&
    snapshot.subscriber.connection === "unconfigured" &&
    typeof snapshot.subscriber.subscriberKey === "string" &&
    snapshot.subscriber.subscriberKey.length > 0
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
    "connection",
    "serviceCount",
    "subscriberKeyPresent",
    "connectFormVisible",
  ]);
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
  if (typeof value.connectFormVisible !== "boolean") {
    throw new Error(
      "desktop smoke acknowledgement connect form visibility is invalid",
    );
  }

  return {
    type: smokeRenderMessageType,
    connection: value.connection as DesktopConnection,
    serviceCount: value.serviceCount,
    subscriberKeyPresent: value.subscriberKeyPresent,
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
