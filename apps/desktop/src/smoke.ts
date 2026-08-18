import type { DesktopSnapshot } from "./protocol.js";

export function isHealthySmokeSnapshot(
  snapshot: DesktopSnapshot | undefined,
): snapshot is DesktopSnapshot {
  if (!snapshot || snapshot.appPhase !== "running") return false;
  if (snapshot.publisher && snapshot.publisher.phase !== "running") return false;
  if (snapshot.subscriber && snapshot.subscriber.phase !== "running") return false;
  return Boolean(snapshot.publisher || snapshot.subscriber);
}
