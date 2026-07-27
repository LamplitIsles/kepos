import assert from "node:assert/strict";
import { createConnection } from "node:net";
import { Duplex, PassThrough } from "node:stream";
import { test } from "node:test";

import type { DhtStream } from "../src/mux/hyperdht.js";
import type { Observation } from "../src/mux/observability.js";
import {
  connectionOptionsForRoute,
  parseRoute,
} from "../src/mux/route.js";
import {
  createPublisherConnection,
  listenSubscriberService,
} from "../src/runtime/subscriber.js";
import {
  createMuxSubscriber as createRealMuxSubscriber,
  TerminalPairingError,
} from "../src/mux/transport.js";

class FakeDhtStream extends Duplex implements DhtStream {
  connected: boolean;
  remotePublicKey = Buffer.alloc(32, 7);

  constructor(connected: boolean) {
    super();
    this.connected = connected;
  }

  override _read(): void {}

  override _write(
    _chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    callback();
  }
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function createReadyMuxSubscriber(
  outer: Parameters<typeof createRealMuxSubscriber>[0],
  options?: Parameters<typeof createRealMuxSubscriber>[1],
) {
  options?.onControlReady?.();
  return {
    close: () => {
      outer.destroy();
    },
    controlReady: Promise.resolve("ready" as const),
    open: async () => new PassThrough(),
    pair: async () => undefined,
  };
}

test("auto route permits the HyperDHT local shortcut", () => {
  assert.equal(parseRoute("auto"), "auto");
  assert.deepEqual(connectionOptionsForRoute("auto"), {
    localConnection: true,
    reusableSocket: true,
  });
});

test("public route disables only the HyperDHT local shortcut", () => {
  assert.equal(parseRoute("public"), "public");
  assert.deepEqual(connectionOptionsForRoute("public"), {
    localConnection: false,
    reusableSocket: true,
  });
});

test("unknown route is rejected", () => {
  assert.throws(() => parseRoute("relay"), /route must be auto or public/);
  assert.throws(
    () => connectionOptionsForRoute("relay"),
    /route must be auto or public/,
  );
});

test("does not install an approved outer before control is ready", async () => {
  const stream = new FakeDhtStream(true);
  let resolveControl: (() => void) | undefined;
  const controlReady = new Promise<"ready">((resolve) => {
    resolveControl = () => resolve("ready");
  });
  const connection = createPublisherConnection({
    connect: () => stream,
    createMuxSubscriber: () => ({
      close: () => stream.destroy(),
      controlReady,
      open: async () => new PassThrough(),
      pair: async () => undefined,
    }),
    now: () => 1_000,
    route: "auto",
    sleep: async () => undefined,
  });

  const starting = connection.start();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(connection.status(), "connecting");
  assert.equal(connection.generation(), 0);

  resolveControl?.();
  await starting;
  assert.equal(connection.status(), "connected");
  assert.equal(connection.generation(), 1);

  await connection.stop();
});

test("recovers with a different outer when control readiness fails", async () => {
  const failed = new FakeDhtStream(true);
  const restored = new FakeDhtStream(true);
  const candidates = [failed, restored];
  const connection = createPublisherConnection({
    connect: () => {
      const stream = candidates.shift();
      if (!stream) throw new Error("unexpected connection attempt");
      return stream;
    },
    createMuxSubscriber: (outer) => ({
      close: () => outer.destroy(),
      controlReady: outer === failed
        ? Promise.reject(new Error("control channel timed out"))
        : Promise.resolve("ready" as const),
      open: async () => new PassThrough(),
      pair: async () => undefined,
    }),
    now: () => 1_000,
    route: "auto",
    sleep: async () => undefined,
  });

  connection.startInBackground();
  await waitFor(
    () => connection.status() === "connected",
    "control failure did not recover",
  );

  assert.equal(failed.destroyed, true);
  assert.equal(restored.destroyed, false);
  assert.equal(connection.status(), "connected");
  assert.equal(connection.generation(), 1);

  await connection.stop();
});

test("does not install a legacy outer that closes as negotiation settles", async () => {
  const stream = new FakeDhtStream(true);
  const controlReady = new Promise<"legacy">((resolve) => {
    setImmediate(() => {
      resolve("legacy");
      stream.destroy();
    });
  });
  const connection = createPublisherConnection({
    connect: () => stream,
    createMuxSubscriber: () => ({
      close: () => stream.destroy(),
      controlReady,
      open: async () => new PassThrough(),
      pair: async () => undefined,
    }),
    now: () => 1_000,
    route: "auto",
    sleep: async () => undefined,
  });

  await assert.rejects(connection.start(), /closed before control was ready/i);
  assert.equal(connection.generation(), 0);
  assert.notEqual(connection.status(), "connected");

  await connection.stop();
});

test("does not install a legacy outer that errors as negotiation settles", async () => {
  const stream = new FakeDhtStream(true);
  stream.on("error", () => undefined);
  const controlReady = new Promise<"legacy">((resolve) => {
    setImmediate(() => {
      resolve("legacy");
      stream.emit("error", new Error("outer failed"));
    });
  });
  const connection = createPublisherConnection({
    connect: () => stream,
    createMuxSubscriber: () => ({
      close: () => stream.destroy(),
      controlReady,
      open: async () => new PassThrough(),
      pair: async () => undefined,
    }),
    now: () => 1_000,
    route: "auto",
    sleep: async () => undefined,
  });

  await assert.rejects(connection.start(), /errored before control was ready/i);
  assert.equal(connection.generation(), 0);
  assert.notEqual(connection.status(), "connected");

  await connection.stop();
});

test("invalidates only the matching connection generation once", async () => {
  const events: Observation[] = [];
  const initial = new FakeDhtStream(true);
  const restored = new FakeDhtStream(true);
  const candidates = [initial, restored];
  const connection = createPublisherConnection({
    connect: () => {
      const stream = candidates.shift();
      if (!stream) throw new Error("unexpected connection attempt");
      return stream;
    },
    createMuxSubscriber: createReadyMuxSubscriber,
    now: () => 1_000,
    observe: (event) => events.push(event),
    route: "auto",
    sleep: async () => undefined,
  });

  await connection.start();
  assert.equal(connection.invalidate(0, "home.registry.timeout"), false);
  assert.equal(connection.invalidate(1, "home.registry.timeout"), true);
  assert.equal(connection.invalidate(1, "home.registry.timeout"), false);
  assert.equal(connection.status(), "reconnecting");
  await waitFor(
    () => connection.generation() === 2,
    "invalidated connection did not restore",
  );

  const unhealthy = events.filter(
    ({ event }) => event === "outer.unhealthy",
  );
  assert.equal(unhealthy.length, 1);
  assert.equal(unhealthy[0]?.reason, "home.registry.timeout");
  assert.equal(connection.invalidate(1, "home.registry.timeout"), false);

  await connection.stop();
});

test("reconnect observations report failed attempt delay and total recovery", async () => {
  const events: Observation[] = [];
  const delays: number[] = [];
  const initial = new FakeDhtStream(true);
  const failed = new FakeDhtStream(false);
  const restored = new FakeDhtStream(true);
  const candidates = [initial, failed, restored];
  let now = 1_000;
  const connection = createPublisherConnection({
    connect: () => {
      const stream = candidates.shift();
      if (!stream) throw new Error("unexpected connection attempt");
      if (stream === failed) {
        setImmediate(() => stream.destroy(new Error("holepunch failed")));
      }
      return stream;
    },
    createMuxSubscriber: createReadyMuxSubscriber,
    now: () => now,
    observe: (event) => events.push(event),
    route: "public",
    sleep: async (delayMs) => {
      delays.push(delayMs);
      now += delayMs;
    },
  });

  await connection.start();
  initial.destroy();
  await waitFor(
    () => events.some(({ event }) => event === "outer.restored"),
    "connection did not restore",
  );

  assert.deepEqual(delays, [100]);
  const retry = events.find(({ event }) => event === "outer.retry");
  assert.equal(retry?.route, "public");
  assert.equal(retry?.delayMs, 100);
  assert.equal(retry?.error, "holepunch failed");
  const restoredEvent = events.find(
    ({ event }) => event === "outer.restored",
  );
  assert.equal(restoredEvent?.recoveryAttempt, 2);
  assert.equal(restoredEvent?.recoveryElapsedMs, 100);

  await connection.stop();
});

test("connection attempts carry holepunch details and DHT stats", async () => {
  const events: Observation[] = [];
  const stream = new FakeDhtStream(true);
  const connection = createPublisherConnection({
    connect: (observe) => {
      observe("outer.holepunch", {
        localFirewall: "consistent",
        remoteFirewall: "random",
        localAddressCount: 2,
        remoteAddressCount: 1,
      });
      return stream;
    },
    createMuxSubscriber: createReadyMuxSubscriber,
    dhtStats: () => ({
      punches: { consistent: 1, random: 1, open: 0 },
      relaying: { attempts: 1, successes: 0, aborts: 1 },
    }),
    now: () => 1_000,
    observe: (event) => events.push(event),
    route: "auto",
    sleep: async () => undefined,
  });

  await connection.start();

  assert.equal(events[1]?.event, "outer.holepunch");
  assert.equal(events[1]?.localFirewall, "consistent");
  assert.deepEqual(
    events.find(({ event }) => event === "outer.connected")?.dht,
    {
      punches: { consistent: 1, random: 1, open: 0 },
      relaying: { attempts: 1, successes: 0, aborts: 1 },
    },
  );
  assert.equal(
    events.some(({ event }) => event === "outer.control-ready"),
    true,
  );
  await connection.stop();
});

test("a pending DHT attempt times out before the next retry", async () => {
  const events: Observation[] = [];
  const initial = new FakeDhtStream(true);
  const pending = new FakeDhtStream(false);
  const restored = new FakeDhtStream(true);
  const candidates = [initial, pending, restored];
  let timeout: (() => void) | undefined;
  const connection = createPublisherConnection({
    connect: () => {
      const stream = candidates.shift();
      if (!stream) throw new Error("unexpected connection attempt");
      return stream;
    },
    createMuxSubscriber: createReadyMuxSubscriber,
    connectTimeoutMs: 20_000,
    scheduleConnectTimeout: (_delayMs, onTimeout) => {
      timeout = onTimeout;
      return () => {
        timeout = undefined;
      };
    },
    now: () => 1_000,
    observe: (event) => events.push(event),
    route: "auto",
    sleep: async () => undefined,
  });

  await connection.start();
  initial.destroy();
  await waitFor(() => timeout !== undefined, "timeout was not scheduled");
  timeout?.();
  await waitFor(
    () => events.some(({ event }) => event === "outer.restored"),
    "connection did not retry after timeout",
  );

  assert.equal(pending.destroyed, true);
  assert.equal(
    events.find(({ event }) => event === "outer.retry")?.error,
    "Publisher connection timed out after 20000ms",
  );
  await connection.stop();
});

test("background start keeps retrying without blocking local listeners", async () => {
  const pending = new FakeDhtStream(false);
  const restored = new FakeDhtStream(true);
  const candidates = [pending, restored];
  let timeout: (() => void) | undefined;
  const connection = createPublisherConnection({
    connect: () => {
      const stream = candidates.shift();
      if (!stream) throw new Error("unexpected connection attempt");
      return stream;
    },
    createMuxSubscriber: createReadyMuxSubscriber,
    connectTimeoutMs: 20_000,
    scheduleConnectTimeout: (_delayMs, onTimeout) => {
      timeout = onTimeout;
      return () => {
        timeout = undefined;
      };
    },
    now: () => 1_000,
    route: "auto",
    sleep: async () => undefined,
  });

  connection.startInBackground();
  assert.equal(connection.status(), "reconnecting");
  await waitFor(() => timeout !== undefined, "timeout was not scheduled");
  timeout?.();
  await waitFor(
    () => connection.status() === "connected",
    "background connection did not restore",
  );
  await connection.stop();
});

test("service open yields before retrying a destroyed outer connection", async () => {
  const delays: number[] = [];
  const initial = new FakeDhtStream(true);
  const restored = new FakeDhtStream(true);
  const candidates = [initial, restored];
  const connection = createPublisherConnection({
    connect: () => {
      const stream = candidates.shift();
      if (!stream) throw new Error("unexpected connection attempt");
      return stream;
    },
    createMuxSubscriber: (outer) => ({
      close: () => outer.destroy(),
      pair: async () => undefined,
      open: async () => {
        if (outer === initial) throw new Error("outer destroyed");
        return new PassThrough();
      },
    }),
    now: () => 1_000,
    route: "auto",
    sleep: async (delayMs) => {
      delays.push(delayMs);
      await new Promise((resolve) => setImmediate(resolve));
    },
  });

  await connection.start();
  initial.destroy();
  const stream = await connection.open("ssh");

  assert.deepEqual(delays, [10]);

  stream.destroy();
  await connection.stop();
});

test("pairing retries stop after the invitation expires", async () => {
  let now = 0;
  let attempts = 0;
  let terminalError: Error | undefined;
  const connection = createPublisherConnection({
    connect: () => {
      attempts++;
      throw new Error("publisher unavailable");
    },
    now: () => now,
    onTerminalConnectionError: (error) => {
      terminalError = error;
    },
    pairing: {
      request: {
        token: Buffer.alloc(32).toString("base64url"),
        label: "Neil's Mac",
        platform: "macos",
      },
      expiresAt: 50,
      onApproved: async () => undefined,
    },
    route: "auto",
    sleep: async (delayMs) => {
      now += delayMs;
    },
  });

  connection.startInBackground();
  await waitFor(
    () => terminalError !== undefined,
    "pairing expiry was not reported to the host",
  );
  assert.match(terminalError?.message ?? "", /invitation has expired/);
  assert.equal(attempts, 1);
  await connection.stop();
});

test("pairing reconnect confirms approval without resending the token", async () => {
  const first = new FakeDhtStream(true);
  const restored = new FakeDhtStream(true);
  const candidates = [first, restored];
  const authorizedModes: boolean[] = [];
  let approved = 0;
  let now = 1_000;
  const connection = createPublisherConnection({
    connect: () => {
      const stream = candidates.shift();
      if (!stream) throw new Error("unexpected connection attempt");
      return stream;
    },
    createMuxSubscriber: (outer, options) => {
      authorizedModes.push(options?.authorized ?? true);
      if (outer === restored) setImmediate(() => options?.onControlReady?.());
      return {
        close: () => outer.destroy(),
        controlReady: Promise.resolve("ready" as const),
        open: async () => new PassThrough(),
        pair: async (_request, pairingOptions) => {
          pairingOptions?.onPending?.();
          now = 3_000;
          first.destroy();
          throw new Error("approval response was lost");
        },
      };
    },
    now: () => now,
    pairing: {
      request: {
        token: Buffer.alloc(32).toString("base64url"),
        label: "Neil's Mac",
        platform: "macos",
      },
      expiresAt: 2_000,
      onApproved: async () => {
        approved++;
      },
    },
    route: "auto",
    sleep: async () => undefined,
  });

  connection.startInBackground();
  await waitFor(
    () => connection.status() === "connected",
    "pending approval did not recover",
  );
  assert.deepEqual(authorizedModes, [false, true]);
  assert.equal(approved, 1);
  await connection.stop();
});

test("terminal pairing outcomes do not retry", async () => {
  const stream = new FakeDhtStream(true);
  let attempts = 0;
  let terminalError: Error | undefined;
  const connection = createPublisherConnection({
    connect: () => {
      attempts++;
      return stream;
    },
    createMuxSubscriber: () => ({
      close: () => stream.destroy(),
      open: async () => new PassThrough(),
      pair: async () => {
        throw new TerminalPairingError("denied");
      },
    }),
    now: () => 1_000,
    onTerminalConnectionError: (error) => {
      terminalError = error;
    },
    pairing: {
      request: {
        token: Buffer.alloc(32).toString("base64url"),
        label: "Neil's Mac",
        platform: "macos",
      },
      expiresAt: 2_000,
      onApproved: async () => undefined,
    },
    route: "auto",
    sleep: async () => undefined,
  });

  connection.startInBackground();
  await waitFor(() => terminalError !== undefined, "denial was not reported");
  assert.equal(attempts, 1);
  assert.equal((terminalError as TerminalPairingError).outcome, "denied");
  await connection.stop();
});

test("heartbeat timeout reports one unhealthy outer before reconnecting", async () => {
  const events: Observation[] = [];
  const initial = new FakeDhtStream(true);
  const restored = new FakeDhtStream(true);
  const candidates = [initial, restored];
  let timeoutHeartbeat: (() => void) | undefined;
  const connection = createPublisherConnection({
    connect: () => {
      const stream = candidates.shift();
      if (!stream) throw new Error("unexpected connection attempt");
      return stream;
    },
    createMuxSubscriber: (outer, options) => {
      if (outer === initial) {
        timeoutHeartbeat = () => {
          options?.onHeartbeatTimeout?.({
            lastPongElapsedMs: 35_000,
            missedPongs: 2,
          });
          outer.destroy(new Error("Publisher heartbeat timed out"));
        };
      }
      return {
        close: () => outer.destroy(),
        pair: async () => undefined,
        open: async () => new PassThrough(),
      };
    },
    now: () => 40_000,
    observe: (event) => events.push(event),
    route: "auto",
    sleep: async () => undefined,
  });

  await connection.start();
  timeoutHeartbeat?.();
  await waitFor(
    () => events.some(({ event }) => event === "outer.restored"),
    "heartbeat recovery did not restore",
  );

  const unhealthy = events.filter(
    ({ event }) => event === "outer.unhealthy",
  );
  assert.equal(unhealthy.length, 1);
  assert.equal(unhealthy[0]?.missedPongs, 2);
  assert.equal(unhealthy[0]?.lastPongElapsedMs, 35_000);
  assert.equal(
    events.find(({ event }) => event === "outer.closed")?.outerId,
    unhealthy[0]?.outerId,
  );
  assert.notEqual(
    events.find(({ event }) => event === "outer.restored")?.outerId,
    unhealthy[0]?.outerId,
  );

  await connection.stop();
});

test("aborting a service open rejects promptly and destroys a late tunnel", async () => {
  const outer = new FakeDhtStream(true);
  const lateTunnel = new PassThrough();
  let resolveOpen: ((stream: PassThrough) => void) | undefined;
  const connection = createPublisherConnection({
    connect: () => outer,
    createMuxSubscriber: () => ({
      close: () => outer.destroy(),
      pair: async () => undefined,
      open: async () =>
        new Promise<PassThrough>((resolve) => {
          resolveOpen = resolve;
        }),
    }),
    now: () => 1_000,
    route: "auto",
    sleep: async () => undefined,
  });
  await connection.start();
  const abort = new AbortController();
  const opening = connection.open("ssh", abort.signal);
  abort.abort();

  await assert.rejects(
    Promise.race([
      opening,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("abort timed out")), 100);
      }),
    ]),
    /aborted/,
  );
  resolveOpen?.(lateTunnel);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(lateTunnel.destroyed, true);
  await connection.stop();
});

test("raw TCP closes when tunnel acquisition exceeds its deadline", async () => {
  let aborted = false;
  const listener = await listenSubscriberService(
    "ssh",
    0,
    {
      open: async (_serviceId, signal) => {
        signal?.addEventListener("abort", () => {
          aborted = true;
        });
        return new Promise<never>(() => undefined);
      },
    },
    5,
  );
  const socket = createConnection({ host: "127.0.0.1", port: listener.port });

  try {
    await Promise.race([
      new Promise<void>((resolve, reject) => {
        socket.once("close", resolve);
        socket.once("error", reject);
      }),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("raw TCP close timed out")), 100);
      }),
    ]);
    assert.equal(aborted, true);
  } finally {
    socket.destroy();
    await new Promise<void>((resolve, reject) => {
      listener.server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("stop aborts an initial connection that is still pending", async () => {
  const pending = new FakeDhtStream(false);
  const connection = createPublisherConnection({
    connect: () => pending,
    now: () => 1_000,
    route: "auto",
    sleep: async () => undefined,
  });
  const starting = connection.start();
  await new Promise((resolve) => setImmediate(resolve));

  try {
    await connection.stop();
    await assert.rejects(
      Promise.race([
        starting,
        new Promise<never>((_resolve, reject) => {
          setTimeout(
            () => reject(new Error("connection stop timed out")),
            100,
          );
        }),
      ]),
      /Subscriber stopped/,
    );
  } finally {
    pending.destroy();
  }
});
