import assert from "node:assert/strict";
import { test } from "node:test";

import { createDesktopController } from "../apps/desktop/src/controller.js";
import type { DesktopSnapshot } from "../apps/desktop/src/protocol.js";

const initial: DesktopSnapshot = {
  type: "snapshot",
  phase: "running",
  connection: "connected",
  publisher: {
    displayName: "kosmos",
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
};

test("desktop controller sends the latest snapshot after page readiness", async () => {
  const sent: string[] = [];
  const controller = createDesktopController({
    initialSnapshot: initial,
    send: (message) => sent.push(message),
    openService: async () => {},
    showHome: async () => {},
    quit: async () => {},
  });

  controller.publish({ ...initial, connection: "reconnecting" });
  assert.deepEqual(sent, []);

  await controller.receive('{"type":"ready"}');
  assert.deepEqual(sent.map((message) => JSON.parse(message)), [
    { ...initial, connection: "reconnecting" },
  ]);

  controller.publish({ ...initial, connection: "connected" });
  controller.publish({ ...initial, connection: "connected" });
  assert.equal(sent.length, 2);
});

test("desktop controller opens only a current validated HTTP service", async () => {
  const opened: string[] = [];
  const controller = createDesktopController({
    initialSnapshot: initial,
    send: () => {},
    openService: async (url) => {
      opened.push(url);
    },
    showHome: async () => {},
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
    send: () => {},
    openService: async () => {
      events.push("open:start");
      await opening;
      events.push("open:end");
    },
    showHome: async () => {
      events.push("home");
    },
    quit: async () => {
      events.push("quit");
    },
  });

  const first = controller.receive(
    '{"type":"openService","serviceId":"forgejo"}',
  );
  const second = controller.receive('{"type":"showHome"}');
  const third = controller.receive('{"type":"quit"}');
  const fourth = controller.receive('{"type":"quit"}');

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["open:start"]);
  releaseOpen?.();
  await Promise.all([first, second, third, fourth]);

  assert.deepEqual(events, ["open:start", "open:end", "home", "quit"]);
});
