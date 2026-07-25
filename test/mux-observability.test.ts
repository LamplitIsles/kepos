import assert from "node:assert/strict";
import { once } from "node:events";
import { Duplex, Transform } from "node:stream";
import { test } from "node:test";

import {
  createObserver,
  sanitizeObservation,
  type Observation,
} from "../src/mux/observability.js";
import {
  dhtFirewallName,
  dhtStatsSnapshot,
  dhtStreamSnapshot,
  holepunchObservation,
  type DhtNode,
  type DhtStream,
} from "../src/mux/hyperdht.js";
import {
  createMuxPublisher,
  createMuxSubscriber,
} from "../src/mux/transport.js";

class FramedDuplex extends Duplex {
  peer?: FramedDuplex;

  override _read(): void {}

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const frame = Buffer.from(chunk);
    setImmediate(() => this.peer?.push(frame));
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

function framedPair(): [FramedDuplex, FramedDuplex] {
  const left = new FramedDuplex();
  const right = new FramedDuplex();
  left.peer = right;
  right.peer = left;
  return [left, right];
}

function prefixService(prefix: string): Duplex {
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      callback(null, Buffer.concat([Buffer.from(prefix), chunk]));
    },
  });
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

test("observer writes stable NDJSON context with elapsed time", () => {
  const lines: string[] = [];
  let now = 1_000;
  const observe = createObserver({
    enabled: true,
    role: "subscriber",
    outerId: "outer-sub-1",
    route: "public",
    now: () => now,
    write: (line) => lines.push(line),
  });

  now = 1_125;
  observe("outer.connected", { attempt: 2 });

  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0] ?? ""), {
    component: "kepos",
    timestamp: new Date(1_125).toISOString(),
    elapsedMs: 125,
    role: "subscriber",
    route: "public",
    outerId: "outer-sub-1",
    event: "outer.connected",
    attempt: 2,
  });
});

test("observation sanitization removes secrets and truncates peer keys", () => {
  assert.deepEqual(
    sanitizeObservation({
      seed: "seed",
      pairingToken: "one-time-token",
      nested: {
        secretKey: "secret",
        publicKey: "a".repeat(64),
        remotePublicKey: Buffer.from("b".repeat(64), "hex"),
        rtt: 42,
      },
    }),
    {
      nested: {
        publicKey: "a".repeat(16),
        remotePublicKey: "b".repeat(16),
        rtt: 42,
      },
    },
  );
});

test("observation fields cannot replace stable context", () => {
  const lines: string[] = [];
  const observe = createObserver({
    enabled: true,
    role: "subscriber",
    outerId: "outer-real",
    now: () => 1_000,
    write: (line) => lines.push(line),
  });

  observe("outer.connected", {
    component: "other",
    event: "channel.open",
    outerId: "outer-spoofed",
    role: "publisher",
  });

  const event = JSON.parse(lines[0] ?? "") as Observation;
  assert.equal(event.component, "kepos");
  assert.equal(event.event, "outer.connected");
  assert.equal(event.outerId, "outer-real");
  assert.equal(event.role, "subscriber");
});

test("DHT stream snapshots include live UDX congestion and retransmit state", () => {
  const stream = {
    connected: true,
    rawStream: {
      rtt: 83,
      cwnd: 24,
      inflight: 7,
      rtoCount: 2,
      retransmits: 5,
      fastRecoveries: 3,
      bbrState: 1,
      bbrBandwidth: 4_200_000,
      bytesTransmitted: 12_000,
      packetsTransmitted: 120,
      bytesReceived: 34_000,
      packetsReceived: 340,
      socket: {
        packetsDroppedByKernel: 4,
      },
    },
    toJSON: () => ({ connected: true }),
  } as unknown as DhtStream;

  assert.deepEqual(dhtStreamSnapshot(stream), {
    connected: true,
    udx: {
      rtt: 83,
      cwnd: 24,
      inflight: 7,
      rtoCount: 2,
      retransmits: 5,
      fastRecoveries: 3,
      bbrState: 1,
      bbrBandwidth: 4_200_000,
      bytesTransmitted: 12_000,
      packetsTransmitted: 120,
      bytesReceived: 34_000,
      packetsReceived: 340,
      packetsDroppedByKernel: 4,
    },
  });
});

test("DHT observations expose NAT classes and aggregate punch stats without addresses", () => {
  assert.equal(dhtFirewallName(0), "unknown");
  assert.equal(dhtFirewallName(1), "open");
  assert.equal(dhtFirewallName(2), "consistent");
  assert.equal(dhtFirewallName(3), "random");
  assert.equal(dhtFirewallName(99), "unknown");
  assert.deepEqual(
    holepunchObservation(3, 2, [{ host: "remote", port: 1 }], [
      { host: "local", port: 2 },
      { host: "local-2", port: 3 },
    ]),
    {
      remoteFirewall: "random",
      localFirewall: "consistent",
      remoteAddressCount: 1,
      localAddressCount: 2,
    },
  );

  const node = {
    stats: {
      punches: { consistent: 2, random: 3, open: 5 },
      relaying: { attempts: 7, successes: 1, aborts: 6 },
      queries: { sent: 999 },
    },
  } as unknown as DhtNode;
  assert.deepEqual(dhtStatsSnapshot(node), {
    punches: { consistent: 2, random: 3, open: 5 },
    relaying: { attempts: 7, successes: 1, aborts: 6 },
  });
});

test("mux observations identify channel open, first bytes, totals, and close source", async () => {
  const [subscriberOuter, publisherOuter] = framedPair();
  const subscriberEvents: Observation[] = [];
  const publisherEvents: Observation[] = [];
  let now = 2_000;
  let subscriberTransport = {
    udx: { rtt: 40, retransmits: 1, rtoCount: 0 },
  };
  const publisher = createMuxPublisher(publisherOuter, {
    outerId: "outer-pub-1",
    now: () => now,
    observe: (event) => publisherEvents.push(event),
    connect: async (serviceId) => prefixService(`${serviceId}:`),
  });
  const subscriber = createMuxSubscriber(subscriberOuter, {
    outerId: "outer-sub-1",
    now: () => now,
    observe: (event) => subscriberEvents.push(event),
    transportSnapshot: () => subscriberTransport,
  });

  const stream = await subscriber.open("ssh");
  now = 2_100;
  stream.write("hello");
  const [response] = (await once(stream, "data")) as [Buffer];
  assert.equal(response.toString(), "ssh:hello");

  now = 2_300;
  subscriberTransport = {
    udx: { rtt: 870, retransmits: 6, rtoCount: 2 },
  };
  stream.destroy();
  await once(stream, "close");
  await waitFor(
    () => publisherEvents.some(({ event }) => event === "channel.close"),
    "publisher did not report channel close",
  );

  const subscriberOpen = subscriberEvents.find(
    ({ event }) => event === "channel.open",
  );
  const subscriberOpenOk = subscriberEvents.find(
    ({ event }) => event === "channel.open-ok",
  );
  assert.equal(subscriberOpen?.serviceId, "ssh");
  assert.equal(subscriberOpenOk?.channelId, subscriberOpen?.channelId);
  assert.equal(subscriberOpenOk?.outerId, "outer-sub-1");
  assert.deepEqual(subscriberOpenOk?.transport, {
    udx: { rtt: 40, retransmits: 1, rtoCount: 0 },
  });

  assert.deepEqual(
    subscriberEvents
      .filter(({ event }) => event === "channel.first-byte")
      .map(({ direction, bytes }) => ({ direction, bytes })),
    [
      { direction: "subscriber-to-publisher", bytes: 5 },
      { direction: "publisher-to-subscriber", bytes: 9 },
    ],
  );

  const subscriberClose = subscriberEvents.find(
    ({ event }) => event === "channel.close",
  );
  assert.equal(subscriberClose?.trigger, "local.close");
  assert.equal(subscriberClose?.subscriberToPublisherBytes, 5);
  assert.equal(subscriberClose?.publisherToSubscriberBytes, 9);
  assert.equal(subscriberClose?.durationMs, 300);
  assert.equal(subscriberClose?.subscriberToPublisherFirstByteMs, 100);
  assert.equal(subscriberClose?.publisherToSubscriberFirstByteMs, 100);
  assert.deepEqual(subscriberClose?.transport, {
    udx: { rtt: 870, retransmits: 6, rtoCount: 2 },
  });

  const publisherOpen = publisherEvents.find(
    ({ event }) => event === "channel.open",
  );
  assert.equal(publisherOpen?.channelId, subscriberOpen?.channelId);
  assert.equal(publisherOpen?.serviceId, "ssh");
  assert.equal(publisherOpen?.outerId, "outer-pub-1");

  subscriber.close();
  publisher.close();
});

test("mux reports service open errors without closing the outer connection", async () => {
  const [subscriberOuter, publisherOuter] = framedPair();
  const events: Observation[] = [];
  const publisher = createMuxPublisher(publisherOuter, {
    connect: async () => {
      throw new Error("service unavailable");
    },
  });
  const subscriber = createMuxSubscriber(subscriberOuter, {
    outerId: "outer-sub-2",
    observe: (event) => events.push(event),
  });

  await assert.rejects(() => subscriber.open("ssh"), /service unavailable/);

  const openError = events.find(({ event }) => event === "channel.open-error");
  assert.equal(openError?.serviceId, "ssh");
  assert.equal(openError?.error, "service unavailable");
  assert.equal(subscriberOuter.destroyed, false);
  assert.equal(publisherOuter.destroyed, false);

  subscriber.close();
  publisher.close();
});

test("publisher reports when the local target closes a channel", async () => {
  const [subscriberOuter, publisherOuter] = framedPair();
  const publisherEvents: Observation[] = [];
  const target = prefixService("ssh:");
  const publisher = createMuxPublisher(publisherOuter, {
    observe: (event) => publisherEvents.push(event),
    connect: async () => target,
  });
  const subscriber = createMuxSubscriber(subscriberOuter);
  const stream = await subscriber.open("ssh");

  target.destroy();
  await once(stream, "close");
  await waitFor(
    () => publisherEvents.some(({ event }) => event === "channel.close"),
    "publisher did not report target close",
  );

  const close = publisherEvents.find(({ event }) => event === "channel.close");
  assert.equal(close?.trigger, "target.close");

  subscriber.close();
  publisher.close();
});
