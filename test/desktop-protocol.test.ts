import assert from "node:assert/strict";
import { test } from "node:test";

import {
  parseDesktopCommand,
  serializeDesktopSnapshot,
  type DesktopSnapshot,
} from "../apps/desktop/src/protocol.js";

const snapshot: DesktopSnapshot = {
  type: "snapshot",
  appPhase: "running",
  peer: {
    phase: "running",
    peerKey: "a7".repeat(32),
    gatewayPort: 17_480,
    connections: [{
      label: "phone",
      publicKey: "cd".repeat(32),
      connection: "accept",
      status: "connected",
      generation: 2,
      capability: "ready",
      services: 2,
    }],
    services: [{
      id: "site",
      name: "Site",
      kind: "http",
      source: { localPort: 8080 },
      available: true,
    }],
    bindings: [{
      peer: "phone",
      service: "site",
      listen: { localPort: 0 },
      port: 42_000,
      available: true,
    }],
    pairing: {
      phase: "pending",
      peerKey: "ef".repeat(32),
      keyFingerprint: "ef".repeat(8),
      label: "tablet",
      platform: "android",
    },
  },
};

test("desktop protocol accepts only canonical page commands", () => {
  for (const type of [
    "ready",
    "quit",
    "copyDiagnostics",
    "createPairingInvitation",
    "cancelPairing",
    "approvePairing",
    "denyPairing",
  ]) {
    assert.deepEqual(parseDesktopCommand(JSON.stringify({ type })), { type });
  }
  assert.deepEqual(parseDesktopCommand('{"type":"openService","serviceId":"site"}'), {
    type: "openService",
    serviceId: "site",
  });
  assert.throws(() => parseDesktopCommand('{"type":"setSubscriberPublisher"}'), /unsupported/);
  assert.throws(() => parseDesktopCommand('{"type":"showHome"}'), /unsupported/);
});

test("desktop protocol rejects malformed and open-ended commands", () => {
  assert.throws(() => parseDesktopCommand("{"), /JSON/);
  assert.throws(() => parseDesktopCommand("x".repeat(64 * 1024 + 1)), /64 KiB/);
  assert.throws(() => parseDesktopCommand('{"type":"eval","source":"alert(1)"}'), /unsupported/);
  assert.throws(
    () => parseDesktopCommand('{"type":"openService","serviceId":"../../etc/passwd"}'),
    /service id/,
  );
  assert.throws(
    () => parseDesktopCommand('{"type":"openService","serviceId":"site","url":"https://evil.example"}'),
    /unknown field/,
  );
});

test("desktop snapshot serialization is stable and does not contain private identity material", () => {
  const serialized = serializeDesktopSnapshot(snapshot);
  assert.equal(serialized, serializeDesktopSnapshot({ ...snapshot }));
  assert.deepEqual(JSON.parse(serialized), snapshot);
  assert.doesNotMatch(serialized, /seed|secret/i);
});
