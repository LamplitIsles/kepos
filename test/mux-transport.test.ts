import assert from "node:assert/strict";
import compactModule from "compact-encoding";
import { Duplex, Transform } from "node:stream";
import { once } from "node:events";
import { test } from "node:test";
import ProtomuxModule from "protomux";

import {
  createMuxPublisher,
  createMuxSubscriber,
  type PairingDecision,
} from "../src/mux/transport.js";

const compact = compactModule as { string: unknown };

class FramedDuplex extends Duplex {
  destroyCalls = 0;
  dropWrites = false;
  peer?: FramedDuplex;

  override _read(): void {}

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const frame = Buffer.from(chunk);
    if (!this.dropWrites) setImmediate(() => this.peer?.push(frame));
    callback();
  }

  override destroy(error?: Error): this {
    this.destroyCalls++;
    return super.destroy(error);
  }

  override _final(callback: (error?: Error | null) => void): void {
    setImmediate(() => this.peer?.push(null));
    callback();
  }

  override _destroy(
    error: Error | null,
    callback: (error?: Error | null) => void,
  ): void {
    setImmediate(() => this.peer?.push(null));
    callback(error);
  }
}

class ManualScheduler {
  now = 0;
  private nextId = 0;
  private readonly tasks = new Map<
    number,
    { at: number; callback: () => void }
  >();

  readonly schedule = (delayMs: number, callback: () => void): (() => void) => {
    const id = ++this.nextId;
    this.tasks.set(id, { at: this.now + delayMs, callback });
    return () => this.tasks.delete(id);
  };

  advance(delayMs: number): void {
    const target = this.now + delayMs;
    while (true) {
      const next = [...this.tasks.entries()]
        .filter(([, task]) => task.at <= target)
        .sort((left, right) => left[1].at - right[1].at)[0];
      if (!next) break;
      const [id, task] = next;
      this.tasks.delete(id);
      this.now = task.at;
      task.callback();
    }
    this.now = target;
  }

  pending(): number {
    return this.tasks.size;
  }
}

class PacedService extends Duplex {
  readonly totalChunks: number;
  chunksSent = 0;
  private scheduled = false;

  constructor(totalChunks: number) {
    super();
    this.totalChunks = totalChunks;
  }

  override _read(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      if (this.chunksSent === this.totalChunks) {
        this.push(null);
        return;
      }
      this.chunksSent++;
      this.push(Buffer.alloc(4 * 1024, this.chunksSent % 251));
    });
  }

  override _write(
    _chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    callback();
  }
}

function framedPair(): [FramedDuplex, FramedDuplex] {
  const left = new FramedDuplex();
  const right = new FramedDuplex();
  left.peer = right;
  right.peer = left;
  return [left, right];
}

function openRawPairingChannel(outer: Duplex): void {
  const Protomux = ProtomuxModule as unknown as new (
    stream: Duplex,
  ) => {
    createChannel(options: {
      protocol: string;
      id: Uint8Array;
      handshake: unknown;
    }): { open(handshake: string): void } | null;
  };
  const mux = new Protomux(outer);
  const channel = mux.createChannel({
    protocol: "kepos/pair/1",
    id: Buffer.alloc(16, 1),
    handshake: compact.string,
  });
  assert.ok(channel);
  channel.open("");
}

async function flushFrames(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function heartbeatOptions(scheduler: ManualScheduler) {
  return {
    intervalMs: 15,
    missedPongsBeforeTimeout: 2,
    responseTimeoutMs: 10,
    schedule: scheduler.schedule,
  };
}

function prefixService(prefix: string): Duplex {
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      callback(null, Buffer.concat([Buffer.from(prefix), chunk]));
    },
  });
}

function replyAfterFin(): Duplex {
  let request = "";
  return new Duplex({
    read() {},
    write(chunk: Buffer, _encoding, callback) {
      request += chunk.toString();
      callback();
    },
    final(callback) {
      this.push(`reply:${request}`);
      this.push(null);
      callback();
    },
  });
}

async function exchange(stream: Duplex, payload: string): Promise<string> {
  const response = once(stream, "data");
  stream.write(payload);
  const [chunk] = (await response) as [Buffer];
  return chunk.toString();
}

async function readToEnd(stream: Duplex): Promise<string> {
  stream.setEncoding("utf8");
  let body = "";
  stream.on("data", (chunk: string) => {
    body += chunk;
  });
  await once(stream, "end");
  return body;
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("multiplexes independent service streams over one persistent connection", async () => {
  const [subscriberOuter, publisherOuter] = framedPair();
  const openedServices: string[] = [];
  const publisher = createMuxPublisher(publisherOuter, {
    connect: async (serviceId) => {
      openedServices.push(serviceId);
      return prefixService(`${serviceId}:`);
    },
  });
  const subscriber = createMuxSubscriber(subscriberOuter);

  const [home, ssh] = await Promise.all([
    subscriber.open("home"),
    subscriber.open("ssh"),
  ]);

  assert.equal(await exchange(home, "page"), "home:page");
  assert.equal(await exchange(ssh, "hello"), "ssh:hello");

  home.destroy();
  ssh.destroy();
  await Promise.all([once(home, "close"), once(ssh, "close")]);

  assert.equal(subscriberOuter.destroyed, false);
  assert.equal(publisherOuter.destroyed, false);

  const navidrome = await subscriber.open("navidrome");
  assert.equal(await exchange(navidrome, "song"), "navidrome:song");
  assert.deepEqual(openedServices.sort(), ["home", "navidrome", "ssh"]);

  navidrome.destroy();
  subscriber.close();
  publisher.close();
});

test("promotes a pairing candidate to services on the same outer", async () => {
  const [subscriberOuter, publisherOuter] = framedPair();
  const scheduler = new ManualScheduler();
  let decision: PairingDecision | undefined;
  const publisher = createMuxPublisher(publisherOuter, {
    authorized: false,
    connect: async (serviceId) => prefixService(`${serviceId}:`),
    onPairingRequest: (request, candidateDecision) => {
      assert.deepEqual(request, {
        token: Buffer.alloc(32, 7).toString("base64url"),
        label: "Neil's Mac",
        platform: "macos",
      });
      decision = candidateDecision;
    },
    schedulePairingRequestDeadline: scheduler.schedule,
  });
  const subscriber = createMuxSubscriber(subscriberOuter, {
    authorized: false,
  });
  let pendingResponses = 0;

  await assert.rejects(() => subscriber.open("home"), /not approved/i);
  const pairing = subscriber.pair(
    {
      token: Buffer.alloc(32, 7).toString("base64url"),
      label: "Neil's Mac",
      platform: "macos",
    },
    { onPending: () => pendingResponses++ },
  );
  await waitFor(() => decision !== undefined, "pairing request was not received");
  await waitFor(() => pendingResponses === 1, "pending response was not exposed");
  assert.equal(scheduler.pending(), 0);

  decision?.approve();
  await pairing;
  const home = await subscriber.open("home");
  assert.equal(await exchange(home, "page"), "home:page");
  assert.equal(subscriberOuter.destroyed, false);
  assert.equal(publisherOuter.destroyed, false);

  home.destroy();
  subscriber.close();
  publisher.close();
});

test("approval remains valid after the pending outer closes", async () => {
  const [subscriberOuter, publisherOuter] = framedPair();
  let decision: PairingDecision | undefined;
  const publisher = createMuxPublisher(publisherOuter, {
    authorized: false,
    connect: async () => prefixService("service:"),
    onPairingRequest: (_request, candidateDecision) => {
      decision = candidateDecision;
    },
  });
  const subscriber = createMuxSubscriber(subscriberOuter, {
    authorized: false,
  });
  const pairing = subscriber.pair({
    token: Buffer.alloc(32, 7).toString("base64url"),
    label: "Restarting phone",
    platform: "android",
  });

  await waitFor(() => decision !== undefined, "pairing request was not received");
  subscriber.close();
  await assert.rejects(pairing, /closed/i);
  assert.doesNotThrow(() => decision?.approve());

  publisher.close();
});

test("starts the pairing request deadline only after the channel opens", async () => {
  const scheduler = new ManualScheduler();
  const [candidateOuter, publisherOuter] = framedPair();
  const publisherErrors: Error[] = [];
  publisherOuter.on("error", (error) => publisherErrors.push(error));
  const publisher = createMuxPublisher(publisherOuter, {
    authorized: false,
    connect: async () => prefixService("service:"),
    onPairingRequest: () => undefined,
    schedulePairingRequestDeadline: scheduler.schedule,
  });

  scheduler.advance(5_000);
  assert.equal(publisherOuter.destroyed, false);
  assert.equal(scheduler.pending(), 0);

  openRawPairingChannel(candidateOuter);
  await flushFrames();
  assert.equal(scheduler.pending(), 1);

  scheduler.advance(4_999);
  assert.equal(publisherOuter.destroyed, false);
  scheduler.advance(1);
  assert.equal(publisherOuter.destroyed, true);
  await flushFrames();
  assert.match(publisherErrors[0]?.message ?? "", /deadline exceeded/i);

  candidateOuter.destroy();
  publisher.close();
});

test("closing a pairing mux cancels its request deadline", async () => {
  const scheduler = new ManualScheduler();
  const [candidateOuter, publisherOuter] = framedPair();
  const publisher = createMuxPublisher(publisherOuter, {
    authorized: false,
    connect: async () => prefixService("service:"),
    onPairingRequest: () => undefined,
    schedulePairingRequestDeadline: scheduler.schedule,
  });

  openRawPairingChannel(candidateOuter);
  await flushFrames();
  assert.equal(scheduler.pending(), 1);
  publisher.close();
  await flushFrames();
  assert.equal(scheduler.pending(), 0);

  candidateOuter.destroy();
});

test("keeps one outer alive while publisher answers control heartbeats", async () => {
  const scheduler = new ManualScheduler();
  const [subscriberOuter, publisherOuter] = framedPair();
  const publisher = createMuxPublisher(publisherOuter, {
    connect: async () => prefixService("service:"),
  });
  const subscriber = createMuxSubscriber(subscriberOuter, {
    heartbeat: heartbeatOptions(scheduler),
    now: () => scheduler.now,
  });

  await flushFrames();
  assert.equal(scheduler.pending(), 1);

  scheduler.advance(15);
  await flushFrames();
  scheduler.advance(15);
  await flushFrames();
  scheduler.advance(10);

  assert.equal(subscriberOuter.destroyed, false);
  assert.equal(subscriberOuter.destroyCalls, 0);

  subscriber.close();
  publisher.close();
});

test("destroys a silent outer after two missed heartbeat replies", async () => {
  const scheduler = new ManualScheduler();
  const [subscriberOuter, publisherOuter] = framedPair();
  const errors: Error[] = [];
  subscriberOuter.on("error", (error) => errors.push(error));
  const publisher = createMuxPublisher(publisherOuter, {
    connect: async () => prefixService("service:"),
  });
  createMuxSubscriber(subscriberOuter, {
    heartbeat: heartbeatOptions(scheduler),
    now: () => scheduler.now,
  });

  await flushFrames();
  subscriberOuter.dropWrites = true;
  scheduler.advance(15);
  scheduler.advance(10);
  assert.equal(subscriberOuter.destroyed, false);
  scheduler.advance(10);
  await flushFrames();

  assert.equal(subscriberOuter.destroyCalls, 1);
  assert.match(errors[0]?.message ?? "", /heartbeat timed out/i);

  publisher.close();
});

test("keeps the outer when a fresh heartbeat succeeds after one miss", async () => {
  const scheduler = new ManualScheduler();
  const [subscriberOuter, publisherOuter] = framedPair();
  const publisher = createMuxPublisher(publisherOuter, {
    connect: async () => prefixService("service:"),
  });
  const subscriber = createMuxSubscriber(subscriberOuter, {
    heartbeat: heartbeatOptions(scheduler),
    now: () => scheduler.now,
  });

  await flushFrames();
  subscriberOuter.dropWrites = true;
  scheduler.advance(15);
  subscriberOuter.dropWrites = false;
  scheduler.advance(10);
  await flushFrames();
  scheduler.advance(10);

  assert.equal(subscriberOuter.destroyed, false);
  assert.equal(subscriberOuter.destroyCalls, 0);

  subscriber.close();
  publisher.close();
});

test("leaves heartbeat disabled for a publisher without control protocol support", async () => {
  const scheduler = new ManualScheduler();
  const [subscriberOuter, publisherOuter] = framedPair();
  const publisher = createMuxPublisher(publisherOuter, {
    connect: async () => prefixService("legacy:"),
    heartbeat: false,
  });
  const subscriber = createMuxSubscriber(subscriberOuter, {
    heartbeat: heartbeatOptions(scheduler),
    now: () => scheduler.now,
  });

  await flushFrames();
  scheduler.advance(100);
  assert.equal(scheduler.pending(), 0);
  assert.equal(subscriberOuter.destroyed, false);

  const stream = await subscriber.open("home");
  assert.equal(await exchange(stream, "page"), "legacy:page");

  stream.destroy();
  subscriber.close();
  publisher.close();
});

test("cancels heartbeat work when mux peers close", async () => {
  const scheduler = new ManualScheduler();
  const [subscriberOuter, publisherOuter] = framedPair();
  const publisher = createMuxPublisher(publisherOuter, {
    connect: async () => prefixService("service:"),
  });
  const subscriber = createMuxSubscriber(subscriberOuter, {
    heartbeat: heartbeatOptions(scheduler),
    now: () => scheduler.now,
  });

  await flushFrames();
  assert.equal(scheduler.pending(), 1);
  subscriber.close();
  publisher.close();
  const subscriberDestroyCalls = subscriberOuter.destroyCalls;
  const publisherDestroyCalls = publisherOuter.destroyCalls;

  scheduler.advance(100);
  await flushFrames();

  assert.equal(scheduler.pending(), 0);
  assert.equal(subscriberOuter.destroyCalls, subscriberDestroyCalls);
  assert.equal(publisherOuter.destroyCalls, publisherDestroyCalls);
});

test("rejects an unpublished service without closing the persistent connection", async () => {
  const [subscriberOuter, publisherOuter] = framedPair();
  const publisher = createMuxPublisher(publisherOuter, {
    connect: async (serviceId) => {
      if (serviceId !== "home") {
        throw new Error(`Service is not published: ${serviceId}`);
      }
      return prefixService("home:");
    },
  });
  const subscriber = createMuxSubscriber(subscriberOuter);

  await assert.rejects(
    () => subscriber.open("database"),
    /not published.*database/i,
  );
  assert.equal(subscriberOuter.destroyed, false);
  assert.equal(publisherOuter.destroyed, false);

  const home = await subscriber.open("home");
  assert.equal(await exchange(home, "page"), "home:page");

  home.destroy();
  subscriber.close();
  publisher.close();
});

test("preserves TCP half-close so a service can reply after request FIN", async () => {
  const [subscriberOuter, publisherOuter] = framedPair();
  const publisher = createMuxPublisher(publisherOuter, {
    connect: async () => replyAfterFin(),
  });
  const subscriber = createMuxSubscriber(subscriberOuter);
  const stream = await subscriber.open("request-response");

  const response = Promise.race([
    readToEnd(stream),
    new Promise<string>((_resolve, reject) => {
      setTimeout(() => reject(new Error("half-close timed out")), 100);
    }),
  ]);
  stream.end("question");

  await assert.doesNotReject(async () => {
    assert.equal(await response, "reply:question");
  });

  subscriber.close();
  publisher.close();
});

test("pauses one service when its subscriber channel applies backpressure", async () => {
  const [subscriberOuter, publisherOuter] = framedPair();
  const service = new PacedService(128);
  const publisher = createMuxPublisher(publisherOuter, {
    connect: async () => service,
  });
  const subscriber = createMuxSubscriber(subscriberOuter);
  const stream = await subscriber.open("download");

  await waitFor(
    () => stream.readableLength >= stream.readableHighWaterMark,
    "subscriber buffer never filled",
  );
  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.ok(
    service.chunksSent < service.totalChunks,
    "publisher source stops before buffering the complete response",
  );

  stream.resume();
  await once(stream, "end");
  assert.equal(service.chunksSent, service.totalChunks);

  subscriber.close();
  publisher.close();
});
