import assert from "node:assert/strict";
import { test } from "node:test";

import { createDesktopController } from "../apps/desktop/src/controller.js";
import type { DesktopSnapshot } from "../apps/desktop/src/protocol.js";

const initial: DesktopSnapshot = {
  type: "snapshot",
  appPhase: "running",
  peer: {
    phase: "running",
    peerKey: "cd".repeat(32),
    gatewayPort: 17_480,
    connections: [],
    services: [
      {
        id: "forgejo",
        name: "Forgejo",
        kind: "http",
        source: { localPort: 8080 },
        available: true,
        access: "http",
        action: "open",
        icon: "git",
        url: "http://forgejo.localhost:17480/",
      },
      {
        id: "ssh",
        name: "SSH",
        kind: "tcp",
        source: { localPort: 22 },
        available: true,
      },
    ],
    bindings: [
      {
        peer: "nuc",
        service: "forgejo",
        listen: { localPort: 0 },
        available: true,
      },
    ],
    pairing: { phase: "idle" },
  },
};

function actions(events: string[] = []) {
  return {
    approvePairing: async (): Promise<void> => { events.push("approve"); },
    cancelPairing: async (): Promise<void> => { events.push("cancel"); },
    createPairingInvitation: async (): Promise<void> => { events.push("create"); },
    denyPairing: async (): Promise<void> => { events.push("deny"); },
    copyDiagnostics: async (): Promise<string> => "",
  };
}

test("desktop controller sends the latest canonical snapshot after page readiness", async () => {
  const sent: string[] = [];
  const controller = createDesktopController({
    initialSnapshot: initial,
    ...actions(),
    send: (message) => sent.push(message),
    openService: async () => {},
    quit: async () => {},
  });

  controller.publish({
    ...initial,
    peer: { ...initial.peer!, connections: [{
      label: "phone",
      publicKey: "ef".repeat(32),
      connection: "accept",
      status: "reconnecting",
      generation: 2,
      capability: "ready",
      services: 0,
    }] },
  });
  assert.deepEqual(sent, []);
  await controller.receive('{"type":"ready"}');
  assert.deepEqual(JSON.parse(sent[0] ?? "null"), JSON.parse(JSON.stringify({
    ...initial,
    peer: { ...initial.peer!, connections: [{
      label: "phone",
      publicKey: "ef".repeat(32),
      connection: "accept",
      status: "reconnecting",
      generation: 2,
      capability: "ready",
      services: 0,
    }] },
  })));
  controller.publish(initial);
  assert.equal(sent.length, 2);
  controller.publish(initial);
  assert.equal(sent.length, 2);
});

test("desktop controller opens only an available canonical HTTP service", async () => {
  const opened: string[] = [];
  const controller = createDesktopController({
    initialSnapshot: initial,
    ...actions(),
    send: () => {},
    openService: async (url) => { opened.push(url); },
    quit: async () => {},
  });
  await controller.receive('{"type":"openService","serviceId":"forgejo"}');
  assert.deepEqual(opened, ["http://forgejo.localhost:17480/"]);
  await assert.rejects(controller.receive('{"type":"openService","serviceId":"ssh"}'), /does not provide an open action/);
  await assert.rejects(controller.receive('{"type":"openService","serviceId":"missing"}'), /not available/);
});

test("desktop controller serializes commands and quits once", async () => {
  const events: string[] = [];
  let releaseOpen: (() => void) | undefined;
  const opening = new Promise<void>((resolve) => { releaseOpen = resolve; });
  const controller = createDesktopController({
    initialSnapshot: initial,
    ...actions(events),
    send: () => {},
    openService: async () => {
      events.push("open:start");
      await opening;
      events.push("open:end");
    },
    quit: async () => { events.push("quit"); },
  });
  const first = controller.receive('{"type":"openService","serviceId":"forgejo"}');
  const second = controller.receive('{"type":"quit"}');
  const third = controller.receive('{"type":"quit"}');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["open:start"]);
  releaseOpen?.();
  await Promise.all([first, second, third]);
  assert.deepEqual(events, ["open:start", "open:end", "quit"]);
});

test("desktop controller forwards canonical pairing and diagnostics actions in order", async () => {
  const events: string[] = [];
  const sent: string[] = [];
  const controller = createDesktopController({
    initialSnapshot: initial,
    ...actions(events),
    send: (message) => sent.push(message),
    openService: async () => {},
    quit: async () => {},
  });
  await Promise.all([
    controller.receive('{"type":"createPairingInvitation"}'),
    controller.receive('{"type":"cancelPairing"}'),
    controller.receive('{"type":"approvePairing"}'),
    controller.receive('{"type":"denyPairing"}'),
    controller.receive('{"type":"copyDiagnostics"}'),
  ]);
  assert.deepEqual(events, ["create", "cancel", "approve", "deny"]);
  assert.deepEqual(JSON.parse(sent.at(-1) ?? "null"), { type: "diagnosticsResult", ok: true, summary: "" });
});
