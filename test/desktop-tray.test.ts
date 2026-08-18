import assert from "node:assert/strict";
import { test } from "node:test";

import { formatTraySnapshot } from "../apps/desktop/src/tray.js";
import type { DesktopSnapshot } from "../apps/desktop/src/protocol.js";

const base = (appPhase: DesktopSnapshot["appPhase"]): DesktopSnapshot => ({
  type: "snapshot",
  appPhase,
});

test("formats app lifecycle tray labels", () => {
  assert.deepEqual(formatTraySnapshot(base("starting")), {
    status: "Kepos — Starting…",
    detail: "Preparing network roles…",
  });
  assert.deepEqual(formatTraySnapshot(base("stopping")), {
    status: "Kepos — Stopping…",
    detail: "Stopping network roles…",
  });
  assert.deepEqual(formatTraySnapshot(base("stopped")), {
    status: "Kepos — Stopped",
    detail: "Network roles stopped",
  });
});

test("formats an unpaired subscriber as waiting for pairing", () => {
  assert.deepEqual(
    formatTraySnapshot({
      type: "snapshot",
      appPhase: "running",
      subscriber: {
        phase: "running",
        connection: "unconfigured",
        subscriberKey: "11".repeat(32),
        services: [],
      },
    }),
    { status: "Kepos — Waiting for pairing", detail: "Subscriber key ready" },
  );
});

test("formats healthy role combinations", () => {
  assert.deepEqual(
    formatTraySnapshot({
      type: "snapshot",
      appPhase: "running",
      publisher: {
        phase: "running",
        activeSubscribers: 2,
        activeSubscriberKeys: ["01".repeat(32), "02".repeat(32)],
        acceptedConnections: 2,
        services: [
          { id: "ssh", name: "SSH", targetPort: 22 },
          { id: "git", name: "Git", targetPort: 3000 },
        ],
      },
    }),
    { status: "Kepos — Online", detail: "2 shared · 2 connected" },
  );
  assert.deepEqual(
    formatTraySnapshot({
      type: "snapshot",
      appPhase: "running",
      subscriber: {
        phase: "running",
        connection: "connected",
        services: [],
      },
    }),
    { status: "Kepos — Online", detail: "Remote connected" },
  );
});

for (const phase of ["failed", "stopped"] as const) {
  for (const role of ["publisher", "subscriber"] as const) {
    test(`marks a ${phase} ${role} as needing attention`, () => {
      assert.deepEqual(
        formatTraySnapshot({
          type: "snapshot",
          appPhase: "running",
          [role]:
            role === "publisher"
              ? {
                  phase,
                  activeSubscribers: 0,
                  activeSubscriberKeys: [],
                  acceptedConnections: 0,
                  services: [],
                }
              : { phase, connection: "stopped", services: [] },
        }),
        {
          status: "Kepos — Attention needed",
          detail: "Open Kepos for details",
        },
      );
    });
  }
}

for (const phase of ["starting", "stopping"] as const) {
  for (const role of ["publisher", "subscriber"] as const) {
    test(`shows a ${phase} ${role} as updating`, () => {
      assert.deepEqual(
        formatTraySnapshot({
          type: "snapshot",
          appPhase: "running",
          [role]:
            role === "publisher"
              ? {
                  phase,
                  activeSubscribers: 0,
                  activeSubscriberKeys: [],
                  acceptedConnections: 0,
                  services: [],
                }
              : { phase, connection: "connecting", services: [] },
        }),
        { status: "Kepos — Online", detail: "Updating network roles…" },
      );
    });
  }
}

test("dual-role attention takes precedence over a healthy peer", () => {
  assert.deepEqual(
    formatTraySnapshot({
      type: "snapshot",
      appPhase: "running",
      publisher: {
        phase: "running",
        activeSubscribers: 1,
        activeSubscriberKeys: ["01".repeat(32)],
        acceptedConnections: 1,
        services: [],
      },
      subscriber: { phase: "failed", connection: "stopped", services: [] },
    }),
    { status: "Kepos — Attention needed", detail: "Open Kepos for details" },
  );
});

test("dual-role attention takes precedence over a transitional peer", () => {
  assert.deepEqual(
    formatTraySnapshot({
      type: "snapshot",
      appPhase: "running",
      publisher: {
        phase: "stopping",
        activeSubscribers: 0,
        activeSubscriberKeys: [],
        acceptedConnections: 0,
        services: [],
      },
      subscriber: { phase: "stopped", connection: "stopped", services: [] },
    }),
    { status: "Kepos — Attention needed", detail: "Open Kepos for details" },
  );
});

test("formats the defensive role-less running state", () => {
  assert.deepEqual(formatTraySnapshot(base("running")), {
    status: "Kepos — Online",
    detail: "Not sharing yet",
  });
});
