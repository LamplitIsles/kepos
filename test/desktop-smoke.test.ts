import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isHealthySmokeSnapshot,
  parseDesktopSmokeRenderAcknowledgement,
} from "../apps/desktop/src/smoke.js";

const peer = {
  phase: "running" as const,
  peerKey: "ab".repeat(32),
  connections: [],
  services: [],
  bindings: [],
};

test("desktop smoke requires a running canonical peer with an identity", () => {
  assert.equal(isHealthySmokeSnapshot({ type: "snapshot", appPhase: "running", peer }), true);
  assert.equal(
    isHealthySmokeSnapshot({
      type: "snapshot",
      appPhase: "running",
      peer: { ...peer, phase: "failed", error: "runtime failed" },
    }),
    false,
  );
  assert.equal(
    isHealthySmokeSnapshot({
      type: "snapshot",
      appPhase: "running",
      peer: { ...peer, peerKey: undefined },
    }),
    false,
  );
});

test("desktop smoke acknowledgement has a closed rendered-page shape", () => {
  const source = JSON.stringify({
    type: "windows-smoke-rendered",
    role: "peer",
    connection: "connecting",
    serviceCount: 0,
    peerKeyPresent: true,
    connectFormVisible: false,
  });
  assert.deepEqual(parseDesktopSmokeRenderAcknowledgement(source), JSON.parse(source));
  assert.throws(
    () => parseDesktopSmokeRenderAcknowledgement(JSON.stringify({ ...JSON.parse(source), snapshot: "synthetic" })),
    /unknown field/,
  );
  assert.equal(parseDesktopSmokeRenderAcknowledgement('{"type":"ready"}'), undefined);
});
