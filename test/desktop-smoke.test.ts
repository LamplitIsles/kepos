import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isHealthySmokeSnapshot,
  isHealthyUnconfiguredSmokeSnapshot,
  parseDesktopSmokeRenderAcknowledgement,
} from "../apps/desktop/src/smoke.js";

const publisher = {
  phase: "running" as const,
  activeSubscribers: 0,
  activeSubscriberKeys: [],
  acceptedConnections: 0,
  services: [],
};

test("desktop smoke accepts a healthy runtime snapshot", () => {
  assert.equal(
    isHealthySmokeSnapshot({ type: "snapshot", appPhase: "running", publisher }),
    true,
  );
});

test("desktop smoke rejects a failed role even when the app phase is running", () => {
  assert.equal(
    isHealthySmokeSnapshot({
      type: "snapshot",
      appPhase: "running",
      publisher: { ...publisher, phase: "failed", error: "role failed" },
    }),
    false,
  );
});

test("desktop smoke requires a real unconfigured subscriber snapshot", () => {
  const snapshot = {
    type: "snapshot" as const,
    appPhase: "running" as const,
    subscriber: {
      phase: "running" as const,
      connection: "unconfigured" as const,
      subscriberKey: "ab".repeat(32),
      services: [],
    },
  };
  assert.equal(isHealthyUnconfiguredSmokeSnapshot(snapshot), true);
  assert.equal(
    isHealthyUnconfiguredSmokeSnapshot({
      ...snapshot,
      subscriber: { ...snapshot.subscriber, connection: "connecting" },
    }),
    false,
  );
});

test("desktop smoke acknowledgement has a closed, rendered-page shape", () => {
  const source = JSON.stringify({
    type: "windows-smoke-rendered",
    connection: "unconfigured",
    serviceCount: 0,
    subscriberKeyPresent: true,
    connectFormVisible: true,
  });
  assert.deepEqual(parseDesktopSmokeRenderAcknowledgement(source), JSON.parse(source));
  assert.throws(
    () =>
      parseDesktopSmokeRenderAcknowledgement(
        JSON.stringify({
          ...JSON.parse(source),
          snapshot: "synthetic",
        }),
      ),
    /unknown field/,
  );
  assert.equal(
    parseDesktopSmokeRenderAcknowledgement('{"type":"ready"}'),
    undefined,
  );
});
