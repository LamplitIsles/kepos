import assert from "node:assert/strict";
import { test } from "node:test";

import { isHealthySmokeSnapshot } from "../apps/desktop/src/smoke.js";

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
