import assert from "node:assert/strict";
import { createSocket, type Socket as UdpSocket } from "node:dgram";
import { test } from "node:test";

import {
  decodeUdpEnvelope,
  decodeUdpFragment,
  encodeUdpDataEnvelopes,
  encodeUdpEnvelope,
  UdpDatagramReassembler,
  UDP_ENVELOPE_HEADER_BYTES,
  UDP_CARRIER_FRAGMENT_PAYLOAD_BYTES,
  UDP_FRAGMENT_HEADER_BYTES,
  UDP_FLOW_ID_BYTES,
  UDP_MAX_SERVICE_ID_BYTES,
  UDP_MAX_PAYLOAD_BYTES,
  createUdpPublisherForwarder,
  createUdpSubscriberTransport,
  type RunningUdpSubscriberTransport,
} from "../src/mux/udp.js";

class FakeOuter {
  peer?: FakeOuter;
  rawStream: unknown = { send: () => true };
  destroyed = false;
  private readonly listeners = new Map<string, Set<(...args: any[]) => void>>();

  on(event: string, listener: (...args: any[]) => void): this {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  off(event: string, listener: (...args: any[]) => void): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  removeListener(event: string, listener: (...args: any[]) => void): this {
    return this.off(event, listener);
  }

  emit(event: string, ...args: any[]): boolean {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
    return true;
  }

  send(message: Uint8Array): boolean {
    this.peer?.emit("message", message);
    return true;
  }

  close(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit("close");
  }
}

function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = (): void => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error("timed out waiting for UDP runtime state"));
        return;
      }
      setTimeout(check, 10).unref();
    };
    check();
  });
}

function carrierRequest(
  transport: RunningUdpSubscriberTransport,
  serviceId: string,
  payload: Uint8Array,
  messageId = 1,
): Promise<Buffer> {
  const flowId = Uint8Array.from(
    { length: UDP_FLOW_ID_BYTES },
    (_, index) => (index + messageId) & 0xff,
  );
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error("UDP exchange timed out"));
    }, 500);
    const unsubscribe = transport.onMessage((message) => {
      let envelope;
      try {
        envelope = decodeUdpEnvelope(message);
      } catch {
        return;
      }
      if (
        envelope.serviceId !== serviceId ||
        envelope.flowId.length !== flowId.length ||
        envelope.flowId.some((value, index) => value !== flowId[index])
      ) {
        return;
      }
      if (envelope.type === "error" || envelope.type === "close") {
        clearTimeout(timer);
        unsubscribe();
        reject(new Error("UDP request was rejected"));
        return;
      }
      clearTimeout(timer);
      unsubscribe();
      resolve(Buffer.from(envelope.payload));
    });
    void (async () => {
      try {
        for (const envelope of encodeUdpDataEnvelopes({
          serviceId,
          flowId,
          payload,
          messageId,
        })) {
          const result = await transport.send(envelope);
          if (!result.ok) throw new Error(result.error ?? "UDP send failed");
        }
      } catch (error) {
        clearTimeout(timer);
        unsubscribe();
        reject(error);
      }
    })();
  });
}

test("UDP envelopes preserve bounded datagrams and reject malformed input", () => {
  assert.equal(UDP_MAX_PAYLOAD_BYTES, 1_200);
  assert.equal(UDP_CARRIER_FRAGMENT_PAYLOAD_BYTES, 1_000);
  const flowId = Uint8Array.from({ length: UDP_FLOW_ID_BYTES }, (_, index) => index);
  const payload = Uint8Array.from([0, 1, 2, 255]);
  const decoded = decodeUdpEnvelope(
    encodeUdpEnvelope({ type: "data", serviceId: "game", flowId, payload }),
  );
  assert.equal(decoded.type, "data");
  assert.equal(decoded.serviceId, "game");
  assert.deepEqual([...decoded.flowId], [...flowId]);
  assert.deepEqual([...decoded.payload], [...payload]);
  assert.deepEqual(
    [...decodeUdpEnvelope(encodeUdpEnvelope({
      type: "data",
      serviceId: "game",
      flowId,
      payload: new Uint8Array(),
    })).payload],
    [],
  );
  assert.throws(
    () => encodeUdpEnvelope({ type: "data", serviceId: "Game", flowId, payload }),
    /service id/,
  );
  assert.throws(
    () => encodeUdpDataEnvelopes({
      serviceId: "game",
      flowId,
      payload: new Uint8Array(UDP_MAX_PAYLOAD_BYTES + 1),
    }),
    /payload/,
  );
  assert.throws(() => decodeUdpEnvelope(Uint8Array.of(0x4b, 0x55, 1)), /length/);
  const malformed = encodeUdpEnvelope({ type: "data", serviceId: "game", flowId, payload });
  malformed[3] = 99;
  assert.throws(() => decodeUdpEnvelope(malformed), /type/);
});

test("UDP codecs reject invalid envelope and fragment boundaries", () => {
  const flowId = Uint8Array.from({ length: UDP_FLOW_ID_BYTES }, (_, index) => index);
  const envelope = encodeUdpEnvelope({
    type: "data",
    serviceId: "game",
    flowId,
    payload: Uint8Array.of(1, 2, 3),
  });
  assert.throws(
    () => encodeUdpEnvelope({ type: "data", serviceId: "game", flowId: Uint8Array.of(1), payload: new Uint8Array() }),
    /flow id/,
  );
  assert.throws(
    () => encodeUdpEnvelope({ type: "data", serviceId: "a" + "x".repeat(UDP_MAX_SERVICE_ID_BYTES), flowId, payload: new Uint8Array() }),
    /service id/,
  );
  assert.throws(
    () => encodeUdpEnvelope({ type: "data", serviceId: "game", flowId, payload: new Uint8Array(UDP_CARRIER_FRAGMENT_PAYLOAD_BYTES + 1) }),
    /fragment/,
  );
  const badServiceLength = Uint8Array.from(envelope);
  badServiceLength[4] = 0;
  assert.throws(() => decodeUdpEnvelope(badServiceLength), /service id length/);
  const oversizedServiceLength = Uint8Array.from(envelope);
  oversizedServiceLength[4] = UDP_MAX_SERVICE_ID_BYTES + 1;
  assert.throws(() => decodeUdpEnvelope(oversizedServiceLength), /service id length/);
  const badPayloadLength = Uint8Array.from(envelope);
  new DataView(badPayloadLength.buffer).setUint16(5 + UDP_FLOW_ID_BYTES, 99);
  assert.throws(() => decodeUdpEnvelope(badPayloadLength), /payload length/);
  const badService = Uint8Array.from(envelope);
  badService[UDP_ENVELOPE_HEADER_BYTES] = 0x21;
  assert.throws(() => decodeUdpEnvelope(badService), /service id/);

  assert.throws(
    () => encodeUdpDataEnvelopes({
      serviceId: "game",
      flowId,
      payload: new Uint8Array(UDP_CARRIER_FRAGMENT_PAYLOAD_BYTES + 1),
    }),
    /message id/,
  );
  assert.throws(
    () => decodeUdpFragment({ type: "data", serviceId: "game", flowId, payload: new Uint8Array() }),
    /not a fragment/,
  );
  assert.throws(
    () => decodeUdpFragment({ type: "fragment", serviceId: "game", flowId, payload: new Uint8Array(UDP_FRAGMENT_HEADER_BYTES - 1) }),
    /truncated/,
  );
  const fragments = encodeUdpDataEnvelopes({
    serviceId: "game",
    flowId,
    payload: new Uint8Array(1_100),
    messageId: 1,
  });
  const validFragment = decodeUdpEnvelope(fragments[0]!);
  const badVersion = Uint8Array.from(validFragment.payload);
  badVersion[0] = 2;
  assert.throws(() => decodeUdpFragment({ ...validFragment, payload: badVersion }), /version/);
  const badMetadata = Uint8Array.from(validFragment.payload);
  new DataView(badMetadata.buffer).setUint16(7, 1);
  assert.throws(() => decodeUdpFragment({ ...validFragment, payload: badMetadata }), /metadata/);
  const badPayload = Uint8Array.from(validFragment.payload).subarray(0, -1);
  assert.throws(() => decodeUdpFragment({ ...validFragment, payload: badPayload }), /payload length/);
});

test("UDP fragments reassemble reordered datagrams and drop incomplete state", () => {
  const flowId = Uint8Array.from({ length: UDP_FLOW_ID_BYTES }, (_, index) => index);
  const payload = Uint8Array.from({ length: UDP_MAX_PAYLOAD_BYTES }, (_, index) => index % 251);
  const encoded = encodeUdpDataEnvelopes({
    serviceId: "game",
    flowId,
    payload,
    messageId: 17,
  });
  assert.equal(encoded.length, 2);
  assert.ok(encoded.every((fragment) => {
    const envelope = decodeUdpEnvelope(fragment);
    return envelope.payload.byteLength <= UDP_CARRIER_FRAGMENT_PAYLOAD_BYTES;
  }));
  const fragments = encoded.map((fragment) =>
    decodeUdpFragment(decodeUdpEnvelope(fragment)),
  );
  let expiry: (() => void) | undefined;
  const drops: string[] = [];
  const reassembler = new UdpDatagramReassembler({
    timeoutMs: 5_000,
    schedule: (_delay, callback) => {
      expiry = callback;
      return () => {
        if (expiry === callback) expiry = undefined;
      };
    },
    onDrop: (reason) => drops.push(reason),
  });
  assert.equal(reassembler.push(fragments[1]!), undefined);
  assert.equal(reassembler.push(fragments[1]!), undefined);
  assert.deepEqual([...reassembler.push(fragments[0]!)!], [...payload]);
  assert.equal(reassembler.push(fragments[0]!), undefined);

  const second = encodeUdpDataEnvelopes({
    serviceId: "game",
    flowId,
    payload: Uint8Array.from({ length: 1_100 }, () => 9),
    messageId: 18,
  }).map((fragment) => decodeUdpFragment(decodeUdpEnvelope(fragment)));
  assert.equal(reassembler.push(second[0]!), undefined);
  expiry?.();
  assert.deepEqual(drops, ["fragment-reassembly-expired"]);
  const later = encodeUdpDataEnvelopes({
    serviceId: "game",
    flowId,
    payload: Uint8Array.from({ length: 1_100 }, () => 7),
    messageId: 19,
  }).map((fragment) => decodeUdpFragment(decodeUdpEnvelope(fragment)));
  assert.equal(reassembler.push(later[1]!), undefined);
  assert.deepEqual(
    [...reassembler.push(later[0]!)!],
    [...Uint8Array.from({ length: 1_100 }, () => 7)],
  );
  reassembler.clear();
});

test("UDP reassembly bounds concurrent messages and rejects metadata conflicts", () => {
  const flowId = Uint8Array.from({ length: UDP_FLOW_ID_BYTES }, (_, index) => index);
  const first = encodeUdpDataEnvelopes({
    serviceId: "game",
    flowId,
    payload: Uint8Array.from({ length: 1_100 }, () => 1),
    messageId: 20,
  }).map((fragment) => decodeUdpFragment(decodeUdpEnvelope(fragment)));
  const second = encodeUdpDataEnvelopes({
    serviceId: "game",
    flowId,
    payload: Uint8Array.from({ length: 1_100 }, () => 2),
    messageId: 21,
  }).map((fragment) => decodeUdpFragment(decodeUdpEnvelope(fragment)));
  const drops: string[] = [];
  const limited = new UdpDatagramReassembler({
    maxMessages: 1,
    maxBytes: UDP_MAX_PAYLOAD_BYTES,
    onDrop: (reason) => drops.push(reason),
  });
  assert.equal(limited.push(first[0]!), undefined);
  assert.equal(limited.push(second[0]!), undefined);

  const byBytes = new UdpDatagramReassembler({
    maxMessages: 2,
    maxBytes: UDP_MAX_PAYLOAD_BYTES,
    onDrop: (reason) => drops.push(reason),
  });
  assert.equal(byBytes.push(first[0]!), undefined);
  assert.equal(byBytes.push(second[0]!), undefined);

  const conflictDrops: string[] = [];
  const conflicting = new UdpDatagramReassembler({
    onDrop: (reason) => conflictDrops.push(reason),
  });
  assert.equal(conflicting.push(first[0]!), undefined);
  assert.equal(
    conflicting.push({ ...first[1]!, count: first[1]!.count + 1 }),
    undefined,
  );
  assert.deepEqual(drops, ["fragment-reassembly-limit", "fragment-reassembly-limit"]);
  assert.deepEqual(conflictDrops, ["fragment-metadata-conflict"]);
});

test("UDP transport latches unsupported and rejected carrier sends", async () => {
  const unsupported = new FakeOuter();
  unsupported.rawStream = {};
  const unsupportedErrors: string[] = [];
  const unsupportedTransport = createUdpSubscriberTransport(unsupported);
  unsupportedTransport.onError((error) => unsupportedErrors.push(error));
  assert.equal(unsupportedTransport.available(), false);
  assert.match(unsupportedErrors[0] ?? "", /unavailable/);
  unsupportedTransport.close();

  const unavailable = new FakeOuter();
  Object.defineProperty(unavailable, "send", { value: () => undefined });
  const unavailableErrors: string[] = [];
  const unavailableTransport = createUdpSubscriberTransport(unavailable);
  unavailableTransport.onError((error) => unavailableErrors.push(error));
  assert.equal((await unavailableTransport.send(Uint8Array.of(1))).ok, false);
  assert.equal(unavailableTransport.available(), false);
  assert.match(unavailableErrors.at(-1) ?? "", /unavailable/);
  unavailableTransport.close();

  const rejected = new FakeOuter();
  Object.defineProperty(rejected, "send", { value: () => false });
  const rejectedErrors: string[] = [];
  const rejectedTransport = createUdpSubscriberTransport(rejected);
  rejectedTransport.onError((error) => rejectedErrors.push(error));
  assert.equal((await rejectedTransport.send(Uint8Array.of(1))).ok, false);
  assert.equal(rejectedTransport.available(), false);
  assert.match(rejectedErrors.at(-1) ?? "", /rejected/);
  rejectedTransport.close();
});

test("UDP forwarder applies ACL before target creation and forwards fixed-target replies", async () => {
  const subscriberOuter = new FakeOuter();
  const publisherOuter = new FakeOuter();
  subscriberOuter.peer = publisherOuter;
  publisherOuter.peer = subscriberOuter;
  let allowed = false;
  const target = await startUdpEcho("reply:");
  const drops: string[] = [];
  const publisher = createUdpPublisherForwarder(publisherOuter, {
    authorized: () => true,
    serviceAuthorized: () => allowed,
    serviceKind: () => "udp",
    localTargetPort: () => target.port,
    onDrop: (reason) => drops.push(reason),
  });
  const subscriber = createUdpSubscriberTransport(subscriberOuter);
  try {
    await assert.rejects(
      carrierRequest(subscriber, "farm", Buffer.from("denied")),
      /rejected|timed out/,
    );
    assert.deepEqual(target.messages, []);
    allowed = true;
    assert.equal(
      (await carrierRequest(subscriber, "farm", Buffer.from("hello"))).toString(),
      "reply:hello",
    );
    assert.deepEqual(
      target.messages.map((message: Buffer) => message.toString()),
      ["hello"],
    );
    assert.equal(publisher.available(), true);
    assert.deepEqual(drops, ["unauthorized-service"]);
  } finally {
    publisher.close();
    subscriber.close();
    await closeUdp(target.socket);
  }
});

test("UDP forwarder drops replies when the shared outbound budget is unavailable", async () => {
  const subscriberOuter = new FakeOuter();
  const publisherOuter = new FakeOuter();
  subscriberOuter.peer = publisherOuter;
  publisherOuter.peer = subscriberOuter;
  const target = await startUdpEcho("reply:");
  const drops: string[] = [];
  const publisher = createUdpPublisherForwarder(publisherOuter, {
    authorized: () => true,
    serviceKind: () => "udp",
    localTargetPort: () => target.port,
    publisherToSubscriberRateLimiter: () => ({
      tryConsume: () => false,
      wait: () => {
        throw new Error("UDP must not queue on the shared rate limiter");
      },
    }),
    onDrop: (reason) => drops.push(reason),
  });
  const subscriber = createUdpSubscriberTransport(subscriberOuter);
  try {
    await assert.rejects(
      carrierRequest(subscriber, "farm", Buffer.from("drop-me")),
      /timed out/,
    );
    await waitFor(() => target.messages.length === 1);
    assert.deepEqual(drops, ["publisher-rate-limit"]);
  } finally {
    publisher.close();
    subscriber.close();
    await closeUdp(target.socket);
  }
});

test("UDP forwarder forwards to a remote service and reports upstream failures", async () => {
  const subscriberOuter = new FakeOuter();
  const publisherOuter = new FakeOuter();
  subscriberOuter.peer = publisherOuter;
  publisherOuter.peer = subscriberOuter;
  let available = true;
  let sendMode: "reply" | "false" | "throw" = "reply";
  let reply: ((flowId: Uint8Array, payload: Uint8Array) => void) | undefined;
  const sent: Array<{ flowId: Uint8Array; payload: Uint8Array; messageId: number }> = [];
  let closedFlows = 0;
  let closedRemote = 0;
  const errors: string[] = [];
  const drops: string[] = [];
  const remote = {
    available: () => available,
    send: async (flowId: Uint8Array, payload: Uint8Array, messageId: number) => {
      sent.push({ flowId: Uint8Array.from(flowId), payload: Uint8Array.from(payload), messageId });
      if (sendMode === "false") return { ok: false, error: "upstream rejected" };
      if (sendMode === "throw") throw new Error("upstream failed");
      reply?.(flowId, Uint8Array.from([...Buffer.from("remote:"), ...payload]));
      return { ok: true };
    },
    closeFlow: () => {
      closedFlows++;
    },
    close: () => {
      closedRemote++;
    },
  };
  const publisher = createUdpPublisherForwarder(publisherOuter, {
    authorized: () => true,
    serviceKind: () => "udp",
    remoteForService: (_serviceId, onReply) => {
      reply = onReply;
      return remote;
    },
    onError: (error) => errors.push(error),
    onDrop: (reason) => drops.push(reason),
  });
  const subscriber = createUdpSubscriberTransport(subscriberOuter);
  try {
    assert.equal(
      (await carrierRequest(subscriber, "upstream", Buffer.from("hello"))).toString(),
      "remote:hello",
    );
    assert.equal(sent[0]?.messageId, 0);
    assert.deepEqual([...sent[0]!.payload], [...Buffer.from("hello")]);

    publisher.receiveReply("upstream", Uint8Array.of(9), Buffer.from("ignored"));
    available = false;
    await assert.rejects(
      carrierRequest(subscriber, "upstream", Buffer.from("offline"), 2),
      /rejected|timed out/,
    );
    assert.deepEqual(drops, ["unavailable-service"]);

    available = true;
    sendMode = "false";
    await subscriber.send(encodeUdpEnvelope({
      type: "data",
      serviceId: "upstream",
      flowId: Uint8Array.from({ length: UDP_FLOW_ID_BYTES }, (_, index) => index + 3),
      payload: Buffer.from("false"),
    }));
    await waitFor(() => errors.some((error) => error.includes("upstream rejected")));

    sendMode = "throw";
    await subscriber.send(encodeUdpEnvelope({
      type: "data",
      serviceId: "upstream",
      flowId: Uint8Array.from({ length: UDP_FLOW_ID_BYTES }, (_, index) => index + 4),
      payload: Buffer.from("throw"),
    }));
    await waitFor(() => errors.some((error) => error.includes("upstream failed")));
    publisher.closeFlows("upstream");
    assert.equal(closedRemote, 1);
    assert.ok(closedFlows >= 2);
  } finally {
    publisher.close();
    subscriber.close();
  }
});

async function startUdpEcho(
  prefix: string,
): Promise<{ socket: UdpSocket; port: number; messages: Buffer[] }> {
  const socket = createSocket("udp4");
  const messages: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(0, "127.0.0.1", () => {
      socket.off("error", reject);
      resolve();
    });
  });
  const address = socket.address();
  if (typeof address === "string") throw new Error("UDP target has no address");
  socket.on("message", (message, remote) => {
    messages.push(Buffer.from(message));
    socket.send(Buffer.concat([Buffer.from(prefix), message]), remote.port, remote.address);
  });
  return { socket, port: address.port, messages };
}

async function closeUdp(socket: UdpSocket | undefined): Promise<void> {
  if (!socket) return;
  await new Promise<void>((resolve) => {
    try {
      socket.close(() => resolve());
    } catch {
      resolve();
    }
  });
}
