import assert from "node:assert/strict";
import { test } from "node:test";

import { formatTraySnapshot } from "../apps/desktop/src/tray.js";
import type { DesktopSnapshot } from "../apps/desktop/src/protocol.js";

const base = (appPhase: DesktopSnapshot["appPhase"]): DesktopSnapshot => ({
  type: "snapshot",
  appPhase,
});

const runningPeer = {
  phase: "running" as const,
  peerKey: "ab".repeat(32),
  connections: [{
    label: "phone",
    publicKey: "cd".repeat(32),
    connection: "accept" as const,
    status: "connected",
    generation: 1,
    services: 1,
  }],
  services: [{
    id: "ssh",
    name: "SSH",
    kind: "tcp" as const,
    source: { localPort: 22 },
    available: true,
  }],
  bindings: [],
};

test("formats canonical app lifecycle tray labels", () => {
  assert.deepEqual(formatTraySnapshot(base("starting")), {
    status: "Kepos — Starting…",
    detail: "Preparing peer network…",
  });
  assert.deepEqual(formatTraySnapshot(base("stopping")), {
    status: "Kepos — Stopping…",
    detail: "Stopping peer network…",
  });
  assert.deepEqual(formatTraySnapshot(base("stopped")), {
    status: "Kepos — Stopped",
    detail: "Peer network stopped",
  });
});

test("formats canonical peer health, pairing, and service counts", () => {
  assert.deepEqual(formatTraySnapshot({ type: "snapshot", appPhase: "running", peer: runningPeer }), {
    status: "Kepos — Online",
    detail: "1 services · 1 peers",
  });
  assert.deepEqual(formatTraySnapshot({
    type: "snapshot",
    appPhase: "running",
    peer: {
      ...runningPeer,
      pairing: { phase: "inviting", expiresAt: Date.now() + 10_000, expired: false },
    },
  }), {
    status: "Kepos — Waiting for pairing",
    detail: "Peer invitation ready",
  });
});

test("marks missing, failed, and transitional peer state as needing attention or updating", () => {
  assert.deepEqual(formatTraySnapshot(base("running")), {
    status: "Kepos — Attention needed",
    detail: "Open Kepos for details",
  });
  for (const phase of ["failed", "stopped"] as const) {
    assert.deepEqual(formatTraySnapshot({
      type: "snapshot",
      appPhase: "running",
      peer: { ...runningPeer, phase },
    }), {
      status: "Kepos — Attention needed",
      detail: "Open Kepos for details",
    });
  }
  for (const phase of ["starting", "stopping"] as const) {
    assert.deepEqual(formatTraySnapshot({
      type: "snapshot",
      appPhase: "running",
      peer: { ...runningPeer, phase },
    }), {
      status: "Kepos — Online",
      detail: "Updating peer network…",
    });
  }
});
