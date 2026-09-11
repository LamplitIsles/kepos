/*
 * Frozen legacy interoperability client.
 *
 * This is deliberately copied from the pre-canonical wire contract at
 * 420efde54e13b8a224d5be30989db0390a033f63.  It does not import the current
 * mux transport or UDP implementation.  Only the repository's DHT wrapper is
 * shared because it is a transport primitive, not a Kepos service codec.
 */
import compactModule from "compact-encoding";
import b4a from "b4a";
import crypto from "hypercore-crypto";
import ProtomuxModule from "protomux";
import { Duplex } from "node:stream";

import {
  createDht,
  keyPairFromSeed,
  type DhtAddress,
  type DhtKeyPair,
  type DhtNode,
  type DhtStream,
} from "../../src/mux/hyperdht.js";
import { connectionOptionsForRoute } from "../../src/mux/route.js";

const Protomux = ProtomuxModule as ProtomuxConstructor;
const compact = compactModule as CompactEncoding;
const tcpProtocol = "kepos/tcp/1";
const pairingProtocol = "kepos/pair/1";
const pairingRequestLimit = 4_096;
const flowIdBytes = 16;
const envelopeHeaderBytes = 2 + 1 + 1 + 1 + flowIdBytes + 2;
const carrierPayloadBytes = 1_000;
const maximumUdpPayloadBytes = 1_200;
const fragmentHeaderBytes = 1 + 4 + 2 + 2 + 2;
const fragmentDataBytes = carrierPayloadBytes - fragmentHeaderBytes;

interface Encoding<T> {
  decode: (state: unknown) => T;
  encode: (state: unknown, value: T) => void;
  preencode: (state: unknown, value: T) => void;
}

interface CompactEncoding {
  buffer: Encoding<Uint8Array>;
  none: Encoding<null>;
  string: Encoding<string>;
  uint: Encoding<number>;
}

interface MuxMessage<T> {
  send: (value: T) => boolean;
}

interface MuxChannel {
  addMessage: <T>(options: {
    encoding: Encoding<T>;
    onmessage: (message: T) => void;
  }) => MuxMessage<T>;
  open: (handshake: string) => void;
  close: () => void;
}

interface MuxInstance {
  createChannel: (options: {
    protocol: string;
    id: Uint8Array;
    handshake: Encoding<string>;
    onopen?: (handshake: string) => void | Promise<void>;
    onclose?: (isRemote: boolean) => void;
    ondrain?: () => void;
  }) => MuxChannel | null;
}

interface ProtomuxConstructor {
  new (stream: DhtStream): MuxInstance;
}

interface PairingRequest {
  token: string;
  label: string;
  platform: string;
}

type PairingResponse =
  | { status: "pending" }
  | { status: "approved" }
  | { status: "denied" }
  | { status: "error"; code: string };

interface TunnelMessages {
  status: MuxMessage<string>;
  data: MuxMessage<Uint8Array>;
  fin: MuxMessage<null>;
  reset: MuxMessage<string>;
  pause: MuxMessage<null>;
  resume: MuxMessage<null>;
}

interface LegacyTunnel extends Duplex {
  readonly ready: Promise<void>;
  accept: () => void;
  reject: (message: string) => void;
  receive: (chunk: Uint8Array) => void;
  receiveFin: () => void;
  receivePause: () => void;
  receiveResume: () => void;
  receiveReset: (message: string) => void;
  remoteClose: () => void;
  outerDrain: () => void;
  attach: (channel: MuxChannel, messages: TunnelMessages) => void;
}

interface LegacyEnvelope {
  type: "data" | "fragment" | "close" | "error";
  serviceId: string;
  flowId: Uint8Array;
  payload: Uint8Array;
}

export interface FrozenLegacyClient {
  publicKey: string;
  open: (serviceId: string) => Promise<LegacyTunnel>;
  catalog: () => Promise<LegacyCatalog>;
  requestHttp: (serviceId: string, requestPath: string) => Promise<string>;
  sendUdp: (serviceId: string, payload: Uint8Array) => Promise<Uint8Array>;
  close: () => Promise<void>;
}

export interface LegacyCatalog {
  publisher?: { publisherKey?: string };
  services?: Array<{ id?: string; name?: string; kind?: string }>;
}

export async function connectFrozenLegacyClient(options: {
  invitation: string;
  seed: string;
  bootstrap: DhtAddress[];
  label: string;
  platform: string;
}): Promise<FrozenLegacyClient> {
  const invitation = parseInvitation(options.invitation);
  const keyPair = keyPairFromSeed(options.seed);
  const dht = createDht({ bootstrap: options.bootstrap, keyPair });
  const outer = dht.connect(Buffer.from(invitation.publisherKey, "hex"), {
    keyPair,
    ...connectionOptionsForRoute("auto"),
  });
  try {
    await waitForConnect(outer);
    const mux = await pair(outer, keyPair, {
      token: invitation.token,
      label: options.label,
      platform: options.platform,
    });
    return createClient(dht, outer, mux, keyPair);
  } catch (error) {
    outer.destroy(error instanceof Error ? error : new Error(String(error)));
    await dht.destroy({ force: true }).catch(() => undefined);
    throw error;
  }
}

function createClient(
  dht: DhtNode,
  outer: DhtStream,
  mux: MuxInstance,
  keyPair: DhtKeyPair,
): FrozenLegacyClient {
  const publicKey = b4a.toString(keyPair.publicKey, "hex");
  return {
    publicKey,
    open: (serviceId) => openLegacyService(mux, serviceId),
    catalog: async () => {
      const tunnel = await openLegacyService(mux, "home");
      try {
        tunnel.end(
          Buffer.from(
            "GET /.well-known/kepos/services.json HTTP/1.1\r\nHost: home.localhost\r\nConnection: close\r\nAccept: application/json\r\n\r\n",
            "latin1",
          ),
        );
        return await readCatalog(tunnel);
      } finally {
        tunnel.destroy();
      }
    },
    requestHttp: async (serviceId, requestPath) => {
      const tunnel = await openLegacyService(mux, serviceId);
      try {
        tunnel.end(
          Buffer.from(
            `GET ${requestPath} HTTP/1.1\r\nHost: legacy.localhost\r\nAuthorization: Bearer forged\r\nConnection: close\r\n\r\n`,
            "latin1",
          ),
        );
        const response = await readHttpResponse(tunnel);
        return response.body;
      } finally {
        tunnel.destroy();
      }
    },
    sendUdp: (serviceId, payload) =>
      sendLegacyUdp(outer, serviceId, payload),
    close: async () => {
      outer.destroy();
      await dht.destroy({ force: true });
    },
  };
}

async function pair(
  outer: DhtStream,
  _keyPair: DhtKeyPair,
  request: PairingRequest,
): Promise<MuxInstance> {
  const mux = new Protomux(outer);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };
    const channel = mux.createChannel({
      protocol: pairingProtocol,
      id: crypto.randomBytes(16),
      handshake: compact.string,
      onopen: () => {
        requestMessage.send(request);
      },
      onclose: () => finish(new Error("legacy pairing channel closed")),
    });
    if (!channel) {
      finish(new Error("legacy pairing channel could not be created"));
      return;
    }
    const requestMessage = channel.addMessage({
      encoding: pairingRequestEncoding,
      onmessage: () => undefined,
    });
    channel.addMessage({
      encoding: pairingResponseEncoding,
      onmessage: (response) => {
        if (response.status === "pending") return;
        if (response.status === "approved") {
          finish();
        } else {
          finish(new Error(`legacy pairing ${response.status}`));
        }
      },
    });
    channel.open("");
  });
  return mux;
}

function openLegacyService(
  mux: MuxInstance,
  serviceId: string,
): Promise<LegacyTunnel> {
  const id = crypto.randomBytes(16);
  const tunnel = createLegacyTunnel(mux, id);
  tunnel.channel.open(serviceId);
  return tunnel.stream.ready.then(() => tunnel.stream);
}

function createLegacyTunnel(
  mux: MuxInstance,
  id: Uint8Array,
): { channel: MuxChannel; stream: LegacyTunnel } {
  const stream = new LegacyTunnelImpl();
  const channel = mux.createChannel({
    protocol: tcpProtocol,
    id,
    handshake: compact.string,
    onopen: () => undefined,
    onclose: () => stream.remoteClose(),
    ondrain: () => stream.outerDrain(),
  });
  if (!channel) throw new Error("legacy tunnel channel could not be created");
  const messages: TunnelMessages = {
    status: channel.addMessage({
      encoding: compact.string,
      onmessage: (message) =>
        message === "" ? stream.accept() : stream.reject(message),
    }),
    data: channel.addMessage({
      encoding: compact.buffer,
      onmessage: (chunk) => stream.receive(chunk),
    }),
    fin: channel.addMessage({
      encoding: compact.none,
      onmessage: () => stream.receiveFin(),
    }),
    reset: channel.addMessage({
      encoding: compact.string,
      onmessage: (message) => stream.receiveReset(message),
    }),
    pause: channel.addMessage({
      encoding: compact.none,
      onmessage: () => stream.receivePause(),
    }),
    resume: channel.addMessage({
      encoding: compact.none,
      onmessage: () => stream.receiveResume(),
    }),
  };
  stream.attach(channel, messages);
  return { channel, stream };
}

class LegacyTunnelImpl extends Duplex implements LegacyTunnel {
  readonly ready: Promise<void>;
  private channel?: MuxChannel;
  private messages?: TunnelMessages;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private readyState: "pending" | "ready" | "failed" = "pending";
  private remotePaused = false;
  private localPaused = false;
  private pendingWrite?: {
    chunk: Uint8Array;
    callback: (error?: Error | null) => void;
  };
  private pendingDrain?: (error?: Error | null) => void;
  private remoteClosing = false;

  constructor() {
    super({ allowHalfOpen: true });
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
  }

  attach(channel: MuxChannel, messages: TunnelMessages): void {
    this.channel = channel;
    this.messages = messages;
  }

  accept(): void {
    if (this.readyState !== "pending") return;
    this.readyState = "ready";
    this.resolveReady();
  }

  reject(message: string): void {
    if (this.readyState !== "pending") return;
    this.readyState = "failed";
    this.remoteClosing = true;
    this.rejectReady(new Error(message));
    this.destroy();
  }

  receive(chunk: Uint8Array): void {
    if (this.destroyed) return;
    if (!this.push(b4a.from(chunk)) && !this.localPaused) {
      this.localPaused = true;
      this.messages?.pause.send(null);
    }
  }

  receiveFin(): void {
    if (!this.destroyed) this.push(null);
  }

  receivePause(): void {
    this.remotePaused = true;
  }

  receiveResume(): void {
    this.remotePaused = false;
    this.flushPendingWrite();
  }

  receiveReset(message: string): void {
    this.remoteClosing = true;
    this.destroy(new Error(message || "legacy tunnel reset"));
  }

  remoteClose(): void {
    this.remoteClosing = true;
    if (this.readyState === "pending") {
      this.readyState = "failed";
      this.rejectReady(new Error("legacy tunnel closed before opening"));
      return;
    }
    this.destroy();
  }

  outerDrain(): void {
    const callback = this.pendingDrain;
    this.pendingDrain = undefined;
    callback?.();
  }

  override _read(): void {
    if (!this.localPaused) return;
    this.localPaused = false;
    this.messages?.resume.send(null);
  }

  override _write(
    chunk: Uint8Array,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const copy = b4a.from(chunk);
    if (this.remotePaused) {
      this.pendingWrite = { chunk: copy, callback };
      return;
    }
    if (!this.messages?.data.send(copy)) {
      this.pendingDrain = callback;
      return;
    }
    callback();
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.messages?.fin.send(null);
    callback();
  }

  override _destroy(
    error: Error | null,
    callback: (error?: Error | null) => void,
  ): void {
    if (this.readyState === "pending") {
      this.readyState = "failed";
      this.rejectReady(error ?? new Error("legacy tunnel closed before opening"));
    }
    if (error && !this.remoteClosing) this.messages?.reset.send(error.message);
    this.channel?.close();
    callback();
  }

  private flushPendingWrite(): void {
    const pending = this.pendingWrite;
    if (!pending) return;
    this.pendingWrite = undefined;
    if (!this.messages?.data.send(pending.chunk)) {
      this.pendingDrain = pending.callback;
    } else {
      pending.callback();
    }
  }
}

const pairingRequestEncoding = jsonEncoding<PairingRequest>(
  "legacy pairing request",
  (value) => {
    if (
      !isRecord(value) ||
      typeof value.token !== "string" ||
      typeof value.label !== "string" ||
      typeof value.platform !== "string"
    ) {
      throw new Error("legacy pairing request is invalid");
    }
    return {
      token: value.token,
      label: value.label,
      platform: value.platform,
    };
  },
);

const pairingResponseEncoding = jsonEncoding<PairingResponse>(
  "legacy pairing response",
  (value) => {
    if (!isRecord(value) || typeof value.status !== "string") {
      throw new Error("legacy pairing response is invalid");
    }
    if (
      value.status !== "pending" &&
      value.status !== "approved" &&
      value.status !== "denied" &&
      value.status !== "error"
    ) {
      throw new Error("legacy pairing response status is invalid");
    }
    return value as PairingResponse;
  },
);

function jsonEncoding<T>(label: string, parse: (value: unknown) => T): Encoding<T> {
  return {
    preencode(state, value): void {
      const target = state as EncodingState;
      const bytes = serializeJson(label, parse(value));
      compact.uint.preencode(target, bytes.byteLength);
      target.end += bytes.byteLength;
    },
    encode(state, value): void {
      const target = state as EncodingState;
      const bytes = serializeJson(label, parse(value));
      compact.uint.encode(target, bytes.byteLength);
      target.buffer.set(bytes, target.start);
      target.start += bytes.byteLength;
    },
    decode(state): T {
      const target = state as EncodingState;
      const length = compact.uint.decode(target);
      if (length > pairingRequestLimit || length !== target.end - target.start) {
        throw new Error(`${label} frame is invalid`);
      }
      let value: unknown;
      try {
        const bytes = target.buffer.subarray(target.start, target.end);
        const text = b4a.toString(bytes, "utf8");
        if (!b4a.equals(bytes, b4a.from(text, "utf8"))) throw new Error("UTF-8");
        value = JSON.parse(text);
      } catch {
        throw new Error(`${label} payload is invalid`);
      }
      target.start = target.end;
      return parse(value);
    },
  };
}

interface EncodingState {
  start: number;
  end: number;
  buffer: Uint8Array;
}

function serializeJson(label: string, value: unknown): Uint8Array {
  const bytes = b4a.from(JSON.stringify(value), "utf8");
  if (bytes.byteLength > pairingRequestLimit) throw new Error(`${label} is too large`);
  return bytes;
}

function parseInvitation(source: string): {
  publisherKey: string;
  token: string;
} {
  const url = new URL(source);
  const publisherKey = url.searchParams.get("publisher") ?? "";
  const token = url.searchParams.get("token") ?? "";
  const expires = Number(url.searchParams.get("expires"));
  if (
    url.protocol !== "kepos:" ||
    url.hostname !== "pair" ||
    !/^[0-9a-f]{64}$/u.test(publisherKey) ||
    !/^[A-Za-z0-9_-]{43}$/u.test(token) ||
    !Number.isSafeInteger(expires) ||
    expires * 1_000 <= Date.now()
  ) {
    throw new Error("frozen legacy invitation is invalid");
  }
  return { publisherKey, token };
}

async function waitForConnect(stream: DhtStream): Promise<void> {
  if (stream.connected) return;
  await new Promise<void>((resolve, reject) => {
    const onConnect = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error("legacy client connection closed before connect"));
    };
    const cleanup = (): void => {
      stream.off("connect", onConnect);
      stream.off("error", onError);
      stream.off("close", onClose);
    };
    stream.once("connect", onConnect);
    stream.once("error", onError);
    stream.once("close", onClose);
  });
}

async function readCatalog(tunnel: Duplex): Promise<LegacyCatalog> {
  const response = await readBytes(tunnel);
  const body = decodeHttpBody(response);
  const value: unknown = JSON.parse(body.toString("utf8"));
  if (!isRecord(value)) throw new Error("legacy catalog is invalid");
  return value as LegacyCatalog;
}

async function readHttpResponse(
  tunnel: Duplex,
): Promise<{ body: string; headers: Record<string, string> }> {
  const response = readBytes(tunnel);
  const source = await response;
  const split = source.indexOf(Buffer.from("\r\n\r\n", "latin1"));
  if (split < 0) throw new Error("legacy HTTP response has no header");
  const header = source.subarray(0, split).toString("latin1");
  const headers: Record<string, string> = {};
  for (const line of header.split("\r\n").slice(1)) {
    const colon = line.indexOf(":");
    if (colon > 0) headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
  }
  return {
    headers,
    body: decodeHttpBody(source).toString("utf8"),
  };
}

function readBytes(stream: Duplex): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const onData = (chunk: Buffer | Uint8Array): void => {
      chunks.push(Buffer.from(chunk));
    };
    const onEnd = (): void => finish(undefined, Buffer.concat(chunks));
    const onClose = (): void => finish(undefined, Buffer.concat(chunks));
    const onError = (error: Error): void => finish(error);
    const finish = (error?: Error, value?: Buffer): void => {
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("close", onClose);
      stream.off("error", onError);
      if (error) reject(error);
      else resolve(value ?? Buffer.alloc(0));
    };
    stream.on("data", onData);
    stream.once("end", onEnd);
    stream.once("close", onClose);
    stream.once("error", onError);
  });
}

function decodeHttpBody(source: Buffer): Buffer {
  const split = source.indexOf(Buffer.from("\r\n\r\n", "latin1"));
  if (split < 0) throw new Error("legacy HTTP response is incomplete");
  const header = source.subarray(0, split).toString("latin1").toLowerCase();
  const body = source.subarray(split + 4);
  if (!header.includes("transfer-encoding: chunked")) return body;
  const chunks: Buffer[] = [];
  let offset = 0;
  while (offset < body.byteLength) {
    const lineEnd = body.indexOf(Buffer.from("\r\n", "latin1"), offset);
    if (lineEnd < 0) throw new Error("legacy chunk header is incomplete");
    const size = Number.parseInt(body.subarray(offset, lineEnd).toString("ascii"), 16);
    offset = lineEnd + 2;
    if (size === 0) break;
    if (!Number.isSafeInteger(size) || offset + size + 2 > body.byteLength) {
      throw new Error("legacy chunk is incomplete");
    }
    chunks.push(body.subarray(offset, offset + size));
    offset += size + 2;
  }
  return Buffer.concat(chunks);
}

async function sendLegacyUdp(
  outer: DhtStream,
  serviceId: string,
  payload: Uint8Array,
): Promise<Uint8Array> {
  if (payload.byteLength > maximumUdpPayloadBytes) {
    throw new Error("legacy UDP payload is too large");
  }
  const flowId = crypto.randomBytes(flowIdBytes);
  const packets = encodeLegacyUdp(serviceId, flowId, payload);
  const response = new Promise<Uint8Array>((resolve, reject) => {
    const timer = setTimeout(() => {
      outer.off("message", onMessage);
      reject(new Error("legacy UDP response timed out"));
    }, 5_000);
    const parts = new Map<number, Uint8Array>();
    const onMessage = (message: Uint8Array): void => {
      let envelope: LegacyEnvelope;
      try {
        envelope = decodeLegacyUdp(message);
      } catch {
        return;
      }
      if (envelope.serviceId !== serviceId || !b4a.equals(envelope.flowId, flowId)) return;
      if (envelope.type === "error") {
        clearTimeout(timer);
        outer.off("message", onMessage);
        reject(new Error(b4a.toString(envelope.payload, "utf8")));
        return;
      }
      if (envelope.type === "data") {
        clearTimeout(timer);
        outer.off("message", onMessage);
        resolve(envelope.payload);
        return;
      }
      if (envelope.type !== "fragment") return;
      const fragment = decodeLegacyFragment(envelope.payload);
      parts.set(fragment.index, fragment.payload);
      if (parts.size !== fragment.count) return;
      const output = b4a.alloc(fragment.totalBytes);
      let offset = 0;
      for (let index = 0; index < fragment.count; index += 1) {
        const part = parts.get(index);
        if (!part) return;
        output.set(part, offset);
        offset += part.byteLength;
      }
      clearTimeout(timer);
      outer.off("message", onMessage);
      resolve(output);
    };
    outer.on("message", onMessage);
  });
  for (const packet of packets) {
    const result = outer.send?.(packet);
    if (result === undefined || (await Promise.resolve(result)) === false) {
      throw new Error("legacy UDP carrier is unavailable");
    }
  }
  return response;
}

function encodeLegacyUdp(
  serviceId: string,
  flowId: Uint8Array,
  payload: Uint8Array,
): Uint8Array[] {
  if (payload.byteLength <= carrierPayloadBytes) {
    return [encodeLegacyEnvelope("data", serviceId, flowId, payload)];
  }
  const count = Math.ceil(payload.byteLength / fragmentDataBytes);
  const packets: Uint8Array[] = [];
  const messageIdBytes = crypto.randomBytes(4);
  const messageId = new DataView(
    messageIdBytes.buffer,
    messageIdBytes.byteOffset,
    messageIdBytes.byteLength,
  ).getUint32(0);
  for (let index = 0; index < count; index += 1) {
    const fragment = b4a.alloc(fragmentHeaderBytes + Math.min(
      fragmentDataBytes,
      payload.byteLength - index * fragmentDataBytes,
    ));
    fragment[0] = 1;
    const view = new DataView(
      fragment.buffer,
      fragment.byteOffset,
      fragment.byteLength,
    );
    view.setUint32(1, messageId);
    view.setUint16(5, index);
    view.setUint16(7, count);
    view.setUint16(9, payload.byteLength);
    fragment.set(payload.subarray(index * fragmentDataBytes), fragmentHeaderBytes);
    packets.push(encodeLegacyEnvelope("fragment", serviceId, flowId, fragment));
  }
  return packets;
}

function encodeLegacyEnvelope(
  type: LegacyEnvelope["type"],
  serviceId: string,
  flowId: Uint8Array,
  payload: Uint8Array,
): Uint8Array {
  const service = b4a.from(serviceId, "utf8");
  const result = b4a.alloc(envelopeHeaderBytes + service.byteLength + payload.byteLength);
  result.set([0x4b, 0x55, 1, { data: 1, fragment: 2, close: 3, error: 4 }[type], service.byteLength], 0);
  result.set(flowId, 5);
  new DataView(
    result.buffer,
    result.byteOffset,
    result.byteLength,
  ).setUint16(5 + flowIdBytes, payload.byteLength);
  result.set(service, envelopeHeaderBytes);
  result.set(payload, envelopeHeaderBytes + service.byteLength);
  return result;
}

function decodeLegacyUdp(source: Uint8Array): LegacyEnvelope {
  if (
    source.byteLength < envelopeHeaderBytes ||
    source[0] !== 0x4b ||
    source[1] !== 0x55 ||
    source[2] !== 1
  ) throw new Error("legacy UDP envelope is invalid");
  const serviceLength = source[4] ?? 0;
  const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
  const payloadLength = view.getUint16(5 + flowIdBytes);
  const expected = envelopeHeaderBytes + serviceLength + payloadLength;
  if (!serviceLength || expected !== source.byteLength) throw new Error("legacy UDP envelope length is invalid");
  const types: Array<LegacyEnvelope["type"] | undefined> = [undefined, "data", "fragment", "close", "error"];
  const type = types[source[3] ?? 0];
  if (!type) throw new Error("legacy UDP envelope type is invalid");
  return {
    type,
    serviceId: b4a.toString(source.subarray(envelopeHeaderBytes, envelopeHeaderBytes + serviceLength), "utf8"),
    flowId: b4a.from(source.subarray(5, 5 + flowIdBytes)),
    payload: b4a.from(source.subarray(envelopeHeaderBytes + serviceLength)),
  };
}

function decodeLegacyFragment(source: Uint8Array): {
  index: number;
  count: number;
  totalBytes: number;
  payload: Uint8Array;
} {
  if (source.byteLength < fragmentHeaderBytes || source[0] !== 1) {
    throw new Error("legacy UDP fragment is invalid");
  }
  const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
  return {
    index: view.getUint16(5),
    count: view.getUint16(7),
    totalBytes: view.getUint16(9),
    payload: b4a.from(source.subarray(fragmentHeaderBytes)),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
