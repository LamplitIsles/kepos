import assert from "node:assert/strict";
import { test } from "node:test";

import {
  parseDesktopCommand,
  serializeDesktopSnapshot,
  type DesktopSnapshot,
} from "../apps/desktop/src/protocol.js";

const snapshot: DesktopSnapshot = {
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
      id: "navidrome",
      name: "Navidrome",
      access: "http",
      available: true,
      url: "http://navidrome.localhost:17480/",
      copyText: "http://navidrome.localhost:17480/",
    },
    {
      id: "ssh",
      name: "SSH",
      access: "ssh",
      available: true,
      copyText: "ssh -p 2222 127.0.0.1",
    },
  ],
};

test("desktop protocol accepts only closed page commands", () => {
  assert.deepEqual(parseDesktopCommand('{"type":"ready"}'), {
    type: "ready",
  });
  assert.deepEqual(
    parseDesktopCommand(
      '{"type":"openService","serviceId":"navidrome"}',
    ),
    { type: "openService", serviceId: "navidrome" },
  );
  assert.deepEqual(parseDesktopCommand('{"type":"showHome"}'), {
    type: "showHome",
  });
  assert.deepEqual(parseDesktopCommand('{"type":"quit"}'), {
    type: "quit",
  });
});

test("desktop protocol rejects malformed, oversized, and open-ended commands", () => {
  assert.throws(() => parseDesktopCommand("{"), /JSON/);
  assert.throws(
    () => parseDesktopCommand("x".repeat(64 * 1024 + 1)),
    /64 KiB/,
  );
  assert.throws(
    () => parseDesktopCommand('{"type":"eval","source":"alert(1)"}'),
    /unsupported/,
  );
  assert.throws(
    () =>
      parseDesktopCommand(
        '{"type":"openService","serviceId":"navidrome","url":"https://evil.example"}',
      ),
    /unknown field/,
  );
  assert.throws(
    () =>
      parseDesktopCommand(
        '{"type":"openService","serviceId":"../../etc/passwd"}',
      ),
    /service id/,
  );
});

test("desktop snapshot serialization is stable and round-trippable", () => {
  const serialized = serializeDesktopSnapshot(snapshot);

  assert.equal(serialized, serializeDesktopSnapshot({ ...snapshot }));
  assert.deepEqual(JSON.parse(serialized), snapshot);
});
