import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  createDesktopDiagnosticSink,
  createNoopDesktopDiagnosticSink,
  type DesktopDiagnosticFileSystem,
} from "../apps/desktop/src/diagnostics.js";
import {
  createDesktopConfigObservation,
  createDesktopLifecycleObservation,
  createDesktopRegistryObservation,
  normalizeDesktopDiagnosticEvent,
  serializeDesktopDiagnosticEvent,
} from "../apps/desktop/src/diagnostics-contract.js";
import { createDesktopController } from "../apps/desktop/src/controller.js";
import {
  parseDesktopCommand,
  serializeDesktopDiagnosticsResult,
} from "../apps/desktop/src/protocol.js";
import { defaultDesktopDiagnosticsDirectory } from "../apps/desktop/src/paths.js";
import type { Observation } from "../src/mux/observability.js";

const timestamp = "2026-08-10T12:00:00.000Z";

function transportObservation(
  overrides: Record<string, unknown> = {},
): Observation {
  return {
    component: "kepos",
    timestamp,
    elapsedMs: 12,
    event: "outer.closed",
    role: "subscriber",
    route: "auto",
    outerId: "outer-0123456789abcdef",
    channelId: "0123456789abcdef0123456789abcdef",
    serviceId: "ssh",
    direction: "subscriber-to-publisher",
    trigger: "connect.error",
    bytes: 42,
    remoteFirewall: "random",
    localFirewall: "consistent",
    remotePublicKey: "ab".repeat(32),
    transport: {
      remoteHost: "192.168.1.2",
      remotePort: 49737,
      remotePublicKey: "cd".repeat(32),
      udx: { rtt: 80, packetsDroppedByKernel: 2 },
      nested: { token: "do-not-copy" },
    },
    dht: {
      punches: { consistent: 1, random: 2, open: 3 },
      relaying: { attempts: 4, successes: 1, aborts: 3 },
      endpoint: "udp://192.168.1.2:49737",
    },
    error: "Error: /Users/neil/private/token=secret",
    url: "https://secret.example/path",
    endpoint: "192.168.1.2:49737",
    path: "/Users/neil/private/config.toml",
    secretKey: "ff".repeat(64),
    token: "secret-token",
    config: { password: "secret-value", arbitrary: { nested: true } },
    ...overrides,
  } as unknown as Observation;
}

async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  message: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function fileSizes(directory: string): Promise<number[]> {
  const names = (await readdir(directory)).filter((name) =>
    /^diagnostics(?:\.\d+)?\.log$/.test(name),
  );
  return Promise.all(
    names.map(async (name) => (await stat(path.join(directory, name))).size),
  );
}

test("desktop diagnostics final boundary is closed and drops hostile values", () => {
  const normalized = normalizeDesktopDiagnosticEvent(transportObservation());
  assert.ok(normalized);
  assert.deepEqual(normalized, {
    source: "transport",
    timestamp,
    role: "subscriber",
    event: "outer.closed",
    route: "auto",
    outerId: "outer-0123456789abcdef",
    channelId: "0123456789abcdef0123456789abcdef",
    serviceId: "ssh",
    direction: "subscriber-to-publisher",
    trigger: "connect.error",
    remoteFirewall: "random",
    localFirewall: "consistent",
    remotePublicKey: "abababababababab",
    dht: {
      punches: { consistent: 1, random: 2, open: 3 },
      relaying: { attempts: 4, successes: 1, aborts: 3 },
    },
    elapsedMs: 12,
    bytes: 42,
  });
  const serialized = serializeDesktopDiagnosticEvent(transportObservation());
  assert.doesNotMatch(
    serialized,
    /192\.168|49737|Users\/neil|secret-token|secret-value|do-not-copy|https:\/\//,
  );
  assert.doesNotMatch(serialized, new RegExp("ab".repeat(32)));
  assert.doesNotMatch(serialized, new RegExp("ff".repeat(64)));
  assert.doesNotMatch(serialized, /"transport":|"udx":|"destroyed":/);

  assert.deepEqual(
    normalizeDesktopDiagnosticEvent(
      createDesktopLifecycleObservation("running", () => 1_000),
    ),
    {
      source: "device",
      timestamp: "1970-01-01T00:00:01.000Z",
      event: "desktop.lifecycle",
      phase: "running",
    },
  );
  for (const operation of ["load", "save", "apply"] as const) {
    assert.deepEqual(
      normalizeDesktopDiagnosticEvent(
        createDesktopConfigObservation(
          operation,
          "success",
          undefined,
          () => 1_000,
        ),
      ),
      {
        source: "device",
        timestamp: "1970-01-01T00:00:01.000Z",
        event: "desktop.config",
        operation,
        outcome: "success",
      },
    );
    assert.deepEqual(
      normalizeDesktopDiagnosticEvent(
        createDesktopConfigObservation(
          operation,
          "failed",
          new Error("permission denied at /Users/neil/config.toml"),
          () => 1_000,
        ),
      ),
      {
        source: "device",
        timestamp: "1970-01-01T00:00:01.000Z",
        event: "desktop.config",
        operation,
        outcome: "failed",
        errorCategory: "permission",
      },
    );
  }
  assert.deepEqual(
    normalizeDesktopDiagnosticEvent(
      createDesktopRegistryObservation(
        "retry",
        7,
        3,
        new Error("timed out"),
        () => 1_000,
      ),
    ),
    {
      source: "device",
      timestamp: "1970-01-01T00:00:01.000Z",
      event: "desktop.registry",
      outcome: "retry",
      connectionGeneration: 7,
      serviceCount: 3,
      errorCategory: "timeout",
    },
  );
  assert.equal(
    normalizeDesktopDiagnosticEvent({
      source: "device",
      timestamp,
      event: "desktop.config",
      operation: "save",
      outcome: "failed",
      error: "raw exception must not be accepted",
    }),
    undefined,
  );
});

test("desktop diagnostics reject oversized event input before persistence", () => {
  assert.throws(
    () =>
      serializeDesktopDiagnosticEvent(
        transportObservation({ error: "hostile-".repeat(2_000) }),
      ),
    /8 KiB/,
  );
});

test("desktop diagnostics persistence and copy boundaries remain private", async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), "kepos-desktop-diagnostics-private-"),
  );
  try {
    const sink = createDesktopDiagnosticSink({
      directory: root,
      platform: "win32",
    });
    await sink.ready;
    sink.observe(transportObservation());
    await sink.flush();

    const persisted = await readFile(
      path.join(root, "diagnostics.log"),
      "utf8",
    );
    const copied = await sink.createSummary();
    for (const output of [persisted, copied]) {
      assert.doesNotMatch(
        output,
        /192\.168|49737|Users\/neil|secret-token|secret-value|do-not-copy|https:\/\//,
      );
      assert.doesNotMatch(output, /"transport":|"udx":|"destroyed":/);
      assert.doesNotMatch(output, new RegExp("ff".repeat(64)));
    }
    await sink.shutdown();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop diagnostics rotate, retain four files, and read after restart", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kepos-desktop-diagnostics-"));
  try {
    const sink = createDesktopDiagnosticSink({
      directory: root,
      platform: "darwin",
    });
    await sink.ready;
    for (let index = 0; index < 4_000; index += 1) {
      sink.observe(
        transportObservation({
          event: "channel.close",
          outerId: `outer-${index.toString(16).padStart(16, "0")}`,
          channelId: index.toString(16).padStart(32, "0"),
          bytes: index,
          durationMs: index,
        }),
      );
      if (index % 100 === 99) await sink.flush();
    }
    await sink.flush();
    await waitFor(
      async () => (await fileSizes(root)).length === 4,
      "diagnostic rotation did not create four retained files",
    );
    assert.equal(sink.droppedEventCount(), 0);
    const sizes = await fileSizes(root);
    assert.ok(sizes.every((size) => size <= 256 * 1024));
    assert.ok(sizes.reduce((total, size) => total + size, 0) <= 1024 * 1024);
    const summary = JSON.parse(await sink.createSummary()) as {
      platform: string;
      droppedEvents: number;
      events: unknown[];
    };
    assert.equal(summary.platform, "darwin");
    assert.equal(summary.droppedEvents, 0);
    assert.ok(summary.events.length <= 200);
    assert.ok(summary.events.length > 0);
    await sink.shutdown();

    const restarted = createDesktopDiagnosticSink({
      directory: root,
      platform: "darwin",
    });
    await restarted.ready;
    const restartedSummary = JSON.parse(await restarted.createSummary()) as {
      events: Array<{ bytes?: number }>;
    };
    assert.ok(restartedSummary.events.length > 0);
    assert.equal(restartedSummary.events.at(-1)?.bytes, 3_999);
    await restarted.shutdown();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop diagnostics summary includes observations accepted before copy", async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), "kepos-desktop-diagnostics-copy-"),
  );
  try {
    const sink = createDesktopDiagnosticSink({
      directory: root,
      platform: "win32",
    });
    await sink.ready;
    sink.observe(
      transportObservation({
        event: "channel.close",
        bytes: 20_026,
      }),
    );

    const summary = JSON.parse(await sink.createSummary()) as {
      events: Array<{ bytes?: number }>;
    };
    assert.equal(summary.events.at(-1)?.bytes, 20_026);
    await sink.shutdown();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop diagnostics summary selects exactly the latest 200 events", async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), "kepos-desktop-diagnostics-latest-"),
  );
  try {
    const sink = createDesktopDiagnosticSink({
      directory: root,
      platform: "darwin",
    });
    await sink.ready;
    for (let index = 0; index < 250; index += 1) {
      sink.observe({
        component: "kepos",
        timestamp,
        elapsedMs: index,
        event: "channel.close",
        role: "subscriber",
        outerId: `outer-${index.toString(16).padStart(16, "0")}`,
        channelId: index.toString(16).padStart(32, "0"),
        bytes: index,
      });
    }

    const summary = JSON.parse(await sink.createSummary()) as {
      events: Array<{ bytes?: number }>;
    };
    assert.equal(summary.events.length, 200);
    assert.deepEqual(
      summary.events.map(({ bytes }) => bytes),
      Array.from({ length: 200 }, (_, index) => index + 50),
    );
    await sink.shutdown();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop diagnostic sinks remove roles absent from the current snapshot", async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), "kepos-desktop-diagnostics-roles-"),
  );
  const snapshot = {
    type: "snapshot" as const,
    appPhase: "running" as const,
    publisher: {
      phase: "running" as const,
      activeSubscribers: 1,
      activeSubscriberKeys: [],
      acceptedConnections: 1,
      services: [{ id: "ssh", name: "SSH", targetPort: 22 }],
    },
    subscriber: {
      phase: "running" as const,
      connection: "connected" as const,
      services: [
        {
          id: "home",
          name: "Home",
          access: "http" as const,
          action: "open" as const,
          icon: "web" as const,
          available: true,
        },
      ],
    },
  };
  try {
    const real = createDesktopDiagnosticSink({ directory: root });
    const noop = createNoopDesktopDiagnosticSink("darwin");
    await real.ready;
    for (const sink of [real, noop]) {
      sink.updateSnapshot(snapshot);
      sink.updateSnapshot({ type: "snapshot", appPhase: "running" });
      const summary = JSON.parse(await sink.createSummary()) as {
        roles: Record<string, unknown>;
      };
      assert.deepEqual(summary.roles, {});
    }
    await real.shutdown();
    await noop.shutdown();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop diagnostics tolerate queue overflow, write failure, and a stalled shutdown", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kepos-desktop-diagnostics-failure-"));
  const never = new Promise<void>(() => undefined);
  const missing = (): Error => Object.assign(new Error("missing"), { code: "ENOENT" });
  const hangingFileSystem: DesktopDiagnosticFileSystem = {
    mkdir: async () => undefined,
    readFile: async () => {
      throw missing();
    },
    appendFile: async () => never,
    rename: async () => undefined,
    rm: async () => undefined,
    stat: async () => {
      throw missing();
    },
  };
  try {
    const hanging = createDesktopDiagnosticSink({
      directory: root,
      fileSystem: hangingFileSystem,
    });
    await hanging.ready;
    hanging.observe(transportObservation());
    await new Promise<void>((resolve) => setImmediate(resolve));
    for (let index = 0; index < 300; index += 1) {
      hanging.observe(transportObservation({ bytes: index }));
    }
    assert.ok(hanging.droppedEventCount() > 0);
    const started = Date.now();
    await hanging.shutdown();
    assert.ok(Date.now() - started < 500);

    const failingFileSystem: DesktopDiagnosticFileSystem = {
      ...hangingFileSystem,
      appendFile: async () => {
        throw new Error("write failed");
      },
    };
    const failing = createDesktopDiagnosticSink({
      directory: root,
      fileSystem: failingFileSystem,
    });
    await failing.ready;
    failing.observe(transportObservation());
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(failing.droppedEventCount(), 1);
    await failing.shutdown();

    const rotatingFileSystem: DesktopDiagnosticFileSystem = {
      ...hangingFileSystem,
      stat: async () => ({ size: 256 * 1024 }),
      rm: async () => {
        throw new Error("rotation failed");
      },
    };
    const rotating = createDesktopDiagnosticSink({
      directory: root,
      fileSystem: rotatingFileSystem,
    });
    await rotating.ready;
    rotating.observe(transportObservation());
    await rotating.flush();
    assert.equal(rotating.droppedEventCount(), 1);
    await rotating.shutdown();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop diagnostics create test-owned macOS and Windows-path artifacts", async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), "kepos-desktop-diagnostics-artifacts-"),
  );
  try {
    for (const [name, platform] of [
      ["macos", "darwin"],
      ["windows", "win32"],
    ] as const) {
      const directory = path.join(root, name, "state", "diagnostics");
      const sink = createDesktopDiagnosticSink({ directory, platform });
      try {
        await sink.ready;
        sink.observe(transportObservation({ role: "subscriber" }));
        await waitFor(async () => {
          try {
            return (
              (await stat(path.join(directory, "diagnostics.log"))).size > 0
            );
          } catch {
            return false;
          }
        }, `${platform} artifact was not written`);
      } finally {
        await sink.shutdown();
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop diagnostics command is bounded and serialized with controller commands", async () => {
  assert.deepEqual(parseDesktopCommand('{"type":"copyDiagnostics"}'), {
    type: "copyDiagnostics",
  });
  const sent: string[] = [];
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const controller = createDesktopController({
    initialSnapshot: { type: "snapshot", appPhase: "running" },
    send: (message) => sent.push(message),
    openService: async () => undefined,
    approvePairing: async () => undefined,
    cancelPairing: async () => undefined,
    createPairingInvitation: async () => undefined,
    denyPairing: async () => undefined,
    setSubscriberPublisher: async () => undefined,
    copyDiagnostics: async () => {
      await pending;
      return JSON.stringify({ platform: "win32", droppedEvents: 0, roles: {}, events: [] });
    },
    quit: async () => undefined,
  });

  const copy = controller.receive('{"type":"copyDiagnostics"}');
  const quit = controller.receive('{"type":"quit"}');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(sent, []);
  release();
  await Promise.all([copy, quit]);
  assert.equal(JSON.parse(sent[0] ?? "null").type, "diagnosticsResult");
  assert.equal(sent.length, 1);
  assert.ok(Buffer.byteLength(serializeDesktopDiagnosticsResult({
    type: "diagnosticsResult",
    ok: false,
    errorCategory: "timeout",
  })) < 64 * 1024);
  const copied = serializeDesktopDiagnosticsResult({
    type: "diagnosticsResult",
    ok: true,
    summary: "x".repeat(60 * 1024),
  });
  assert.ok(Buffer.byteLength(copied, "utf8") <= 64 * 1024);
  assert.throws(
    () =>
      serializeDesktopDiagnosticsResult({
        type: "diagnosticsResult",
        ok: true,
        summary: "x".repeat(64 * 1024),
      }),
    /64 KiB/,
  );
});

test("desktop diagnostics directory follows test-owned macOS and Windows state roots", () => {
  assert.equal(
    defaultDesktopDiagnosticsDirectory({
      homeDirectory: "/Users/test-owned",
      environment: { XDG_STATE_HOME: "/tmp/test-state" },
      platform: "darwin",
    }),
    "/tmp/test-state/kepos-neo/diagnostics",
  );
  assert.equal(
    defaultDesktopDiagnosticsDirectory({
      homeDirectory: "C:\\Users\\test-owned",
      environment: { LOCALAPPDATA: "C:\\Users\\test-owned\\AppData\\Local" },
      platform: "win32",
    }),
    "C:\\Users\\test-owned\\AppData\\Local\\Kepos\\state\\diagnostics",
  );
});
