import assert from "node:assert/strict";
import { test } from "node:test";

import { createDesktopController } from "../apps/desktop/src/controller.js";
import type { DesktopSnapshot } from "../apps/desktop/src/protocol.js";

const initial: DesktopSnapshot = {
  type: "snapshot",
  appPhase: "running",
  subscriber: {
    phase: "running",
    connection: "connected",
    subscriberKey: "cd".repeat(32),
    remotePublisher: {
      displayName: "kosmos",
      publisherKey: "e4".repeat(32),
      keyFingerprint: "e499c38286e33f48",
    },
    gatewayPort: 17_480,
    services: [
      {
        id: "forgejo",
        name: "Forgejo",
        access: "http",
        action: "open",
        icon: "git",
        available: true,
        url: "http://forgejo.localhost:17480/",
      },
      {
        id: "navidrome",
        name: "Navidrome",
        access: "http",
        action: "copy-url",
        icon: "music",
        available: true,
        url: "http://navidrome.localhost:17480",
        copyText: "http://navidrome.localhost:17480",
      },
      {
        id: "ssh",
        name: "SSH",
        access: "ssh",
        action: "copy-command",
        icon: "terminal",
        available: true,
        copyText: "ssh -p 2222 127.0.0.1",
      },
    ],
  },
};

const pairingActions = {
  approvePairing: async (): Promise<void> => undefined,
  cancelPairing: async (): Promise<void> => undefined,
  createPairingInvitation: async (): Promise<void> => undefined,
  denyPairing: async (): Promise<void> => undefined,
  setSubscriberPublisher: async (): Promise<void> => undefined,
};

test("desktop controller sends the latest snapshot after page readiness", async () => {
  const sent: string[] = [];
  const controller = createDesktopController({
    initialSnapshot: initial,
    ...pairingActions,
    send: (message) => sent.push(message),
    openService: async () => {},
    quit: async () => {},
  });

  controller.publish({
    ...initial,
    subscriber: { ...initial.subscriber!, connection: "reconnecting" },
  });
  assert.deepEqual(sent, []);

  await controller.receive('{"type":"ready"}');
  assert.deepEqual(sent.map((message) => JSON.parse(message)), [
    {
      ...initial,
      subscriber: { ...initial.subscriber!, connection: "reconnecting" },
    },
  ]);

  controller.publish(initial);
  assert.equal(sent.length, 2);
  assert.deepEqual(JSON.parse(sent.at(-1) ?? "null"), initial);
  controller.publish(initial);
  assert.equal(sent.length, 2);

  await controller.receive('{"type":"ready"}');
  assert.equal(sent.length, 3);
  assert.deepEqual(JSON.parse(sent.at(-1) ?? "null"), initial);
});

test("desktop controller opens only a current validated HTTP service", async () => {
  const opened: string[] = [];
  const controller = createDesktopController({
    initialSnapshot: initial,
    ...pairingActions,
    send: () => {},
    openService: async (url) => {
      opened.push(url);
    },
    quit: async () => {},
  });

  await controller.receive(
    '{"type":"openService","serviceId":"forgejo"}',
  );
  assert.deepEqual(opened, ["http://forgejo.localhost:17480/"]);

  await assert.rejects(
    controller.receive('{"type":"openService","serviceId":"navidrome"}'),
    /not an available HTTP service/,
  );

  await assert.rejects(
    controller.receive('{"type":"openService","serviceId":"ssh"}'),
    /not an available HTTP service/,
  );
  await assert.rejects(
    controller.receive('{"type":"openService","serviceId":"missing"}'),
    /not an available HTTP service/,
  );
});

test("desktop controller serializes commands and quits once", async () => {
  const events: string[] = [];
  let releaseOpen: (() => void) | undefined;
  const opening = new Promise<void>((resolve) => {
    releaseOpen = resolve;
  });
  const controller = createDesktopController({
    initialSnapshot: initial,
    ...pairingActions,
    send: () => {},
    openService: async () => {
      events.push("open:start");
      await opening;
      events.push("open:end");
    },
    quit: async () => {
      events.push("quit");
    },
  });

  const first = controller.receive(
    '{"type":"openService","serviceId":"forgejo"}',
  );
  const second = controller.receive('{"type":"quit"}');
  const third = controller.receive('{"type":"quit"}');

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["open:start"]);
  releaseOpen?.();
  await Promise.all([first, second, third]);

  assert.deepEqual(events, ["open:start", "open:end", "quit"]);
});

test("desktop controller forwards pairing actions in command order", async () => {
  const events: string[] = [];
  const controller = createDesktopController({
    initialSnapshot: initial,
    send: () => undefined,
    openService: async () => undefined,
    createPairingInvitation: async () => {
      events.push("create");
    },
    cancelPairing: async () => {
      events.push("cancel");
    },
    approvePairing: async () => {
      events.push("approve");
    },
    denyPairing: async () => {
      events.push("deny");
    },
    setSubscriberPublisher: async () => undefined,
    quit: async () => undefined,
  });

  await Promise.all([
    controller.receive('{"type":"createPairingInvitation"}'),
    controller.receive('{"type":"cancelPairing"}'),
    controller.receive('{"type":"approvePairing"}'),
    controller.receive('{"type":"denyPairing"}'),
  ]);
  assert.deepEqual(events, ["create", "cancel", "approve", "deny"]);
});
