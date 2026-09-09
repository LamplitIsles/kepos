import { createSocket, type RemoteInfo, type Socket } from "node:dgram";

import b4a from "b4a";

import type { PublisherToSubscriberRateLimiter } from "./rate-limit.js";

/**
 * libudx's 1200 byte baseline is a complete packet budget, including the
 * network, UDP and UDX headers.  The worst-case IPv6 overhead is 68 bytes;
 * unordered SecretStream adds 24 bytes, this envelope adds 23 bytes, and the
 * service identifier is bounded to 64 bytes.  A 1000 byte carrier fragment
 * therefore stays below the resulting 1021 byte ceiling.  Application UDP
 * datagrams may be up to 1200 bytes and are split into bounded unordered
 * fragments when needed.  UDX may probe a larger MTU, but the effective value
 * varies by route and address family.
 */
export const UDP_CARRIER_MTU_BYTES = 1_200;
export const UDP_SECRETSTREAM_MESSAGE_OVERHEAD_BYTES = 24;
export const UDP_MAX_SERVICE_ID_BYTES = 64;
export const UDP_FLOW_ID_BYTES = 16;
export const UDP_ENVELOPE_HEADER_BYTES = 2 + 1 + 1 + 1 + UDP_FLOW_ID_BYTES + 2;
export const UDP_CARRIER_FRAGMENT_PAYLOAD_BYTES = 1_000;
export const UDP_MAX_PAYLOAD_BYTES = 1_200;
export const UDP_FRAGMENT_HEADER_BYTES = 1 + 4 + 2 + 2 + 2;
export const UDP_FRAGMENT_DATA_BYTES =
  UDP_CARRIER_FRAGMENT_PAYLOAD_BYTES - UDP_FRAGMENT_HEADER_BYTES;
export const UDP_MAX_FRAGMENT_COUNT = Math.ceil(
  UDP_MAX_PAYLOAD_BYTES / UDP_FRAGMENT_DATA_BYTES,
);
export const UDP_FLOW_IDLE_TIMEOUT_MS = 60_000;
export const UDP_REASSEMBLY_TIMEOUT_MS = 5_000;
export const UDP_MAX_FLOWS_PER_CONNECTION = 64;
export const UDP_MAX_PENDING_SENDS = 32;
export const UDP_MAX_DATAGRAMS_PER_SECOND = 256;
export const UDP_MAX_BYTES_PER_SECOND = 256 * 1_024;
export const UDP_MAX_REASSEMBLY_MESSAGES = 8;
export const UDP_MAX_REASSEMBLY_BYTES =
  UDP_MAX_REASSEMBLY_MESSAGES * UDP_MAX_PAYLOAD_BYTES;

const envelopeMagic0 = 0x4b;
const envelopeMagic1 = 0x55;
const envelopeVersion = 1;
const envelopeHeaderBytes = UDP_ENVELOPE_HEADER_BYTES;
const maxEnvelopeBytes =
  envelopeHeaderBytes +
  UDP_MAX_SERVICE_ID_BYTES +
  UDP_CARRIER_FRAGMENT_PAYLOAD_BYTES;

export type UdpEnvelopeType = "data" | "fragment" | "close" | "error";

export interface UdpEnvelope {
  type: UdpEnvelopeType;
  serviceId: string;
  flowId: Uint8Array;
  payload: Uint8Array;
}

const envelopeTypeCodes: Record<UdpEnvelopeType, number> = {
  data: 1,
  fragment: 2,
  close: 3,
  error: 4,
};

const envelopeTypesByCode: Record<number, UdpEnvelopeType | undefined> = {
  1: "data",
  2: "fragment",
  3: "close",
  4: "error",
};

export function encodeUdpEnvelope(envelope: UdpEnvelope): Uint8Array {
  const serviceIdBytes = b4a.from(envelope.serviceId, "utf8");
  if (
    serviceIdBytes.byteLength === 0 ||
    serviceIdBytes.byteLength > UDP_MAX_SERVICE_ID_BYTES ||
    !/^[a-z][a-z0-9-]*$/u.test(envelope.serviceId)
  ) {
    throw new Error("UDP envelope service id is invalid or too long");
  }
  if (envelope.flowId.byteLength !== UDP_FLOW_ID_BYTES) {
    throw new Error("UDP envelope flow id must be 16 bytes");
  }
  if (envelope.payload.byteLength > UDP_CARRIER_FRAGMENT_PAYLOAD_BYTES) {
    throw new Error(
      `UDP carrier fragment exceeds ${UDP_CARRIER_FRAGMENT_PAYLOAD_BYTES} bytes`,
    );
  }

  const bodyLength =
    envelopeHeaderBytes + serviceIdBytes.byteLength + envelope.payload.byteLength;
  if (bodyLength > maxEnvelopeBytes) {
    throw new Error("UDP envelope exceeds the carrier budget");
  }

  const encoded = b4a.alloc(bodyLength);
  encoded[0] = envelopeMagic0;
  encoded[1] = envelopeMagic1;
  encoded[2] = envelopeVersion;
  encoded[3] = envelopeTypeCodes[envelope.type];
  encoded[4] = serviceIdBytes.byteLength;
  encoded.set(envelope.flowId, 5);
  const view = new DataView(
    encoded.buffer,
    encoded.byteOffset,
    encoded.byteLength,
  );
  view.setUint16(5 + UDP_FLOW_ID_BYTES, envelope.payload.byteLength);
  let offset = envelopeHeaderBytes;
  encoded.set(serviceIdBytes, offset);
  offset += serviceIdBytes.byteLength;
  encoded.set(envelope.payload, offset);
  return encoded;
}

export function decodeUdpEnvelope(source: Uint8Array): UdpEnvelope {
  if (source.byteLength < envelopeHeaderBytes || source.byteLength > maxEnvelopeBytes) {
    throw new Error("UDP envelope length is outside the supported bound");
  }
  if (
    source[0] !== envelopeMagic0 ||
    source[1] !== envelopeMagic1 ||
    source[2] !== envelopeVersion
  ) {
    throw new Error("UDP envelope version or magic is unsupported");
  }
  const type = envelopesType(source[3]);
  const serviceIdBytes = source[4] ?? 0;
  if (
    serviceIdBytes === 0 ||
    serviceIdBytes > UDP_MAX_SERVICE_ID_BYTES ||
    envelopeHeaderBytes + serviceIdBytes > source.byteLength
  ) {
    throw new Error("UDP envelope service id length is invalid");
  }
  const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
  const payloadBytes = view.getUint16(5 + UDP_FLOW_ID_BYTES);
  const expectedLength = envelopeHeaderBytes + serviceIdBytes + payloadBytes;
  if (
    payloadBytes > UDP_CARRIER_FRAGMENT_PAYLOAD_BYTES ||
    expectedLength !== source.byteLength
  ) {
    throw new Error("UDP envelope payload length is invalid");
  }
  const serviceId = b4a.toString(
    source.subarray(envelopeHeaderBytes, envelopeHeaderBytes + serviceIdBytes),
    "utf8",
  );
  if (!/^[a-z][a-z0-9-]*$/u.test(serviceId)) {
    throw new Error("UDP envelope service id is invalid");
  }
  return {
    type,
    serviceId,
    flowId: b4a.from(source.subarray(5, 5 + UDP_FLOW_ID_BYTES)),
    payload: b4a.from(
      source.subarray(
        envelopeHeaderBytes + serviceIdBytes,
        expectedLength,
      ),
    ),
  };
}

function envelopesType(value: number | undefined): UdpEnvelopeType {
  const type = value === undefined ? undefined : envelopeTypesByCode[value];
  if (type === undefined) throw new Error("UDP envelope type is unsupported");
  return type;
}

export interface UdpDataEnvelopeOptions {
  serviceId: string;
  flowId: Uint8Array;
  payload: Uint8Array;
  messageId?: number;
}

export interface UdpFragment {
  messageId: number;
  index: number;
  count: number;
  totalBytes: number;
  payload: Uint8Array;
}

/** Encode one application datagram as one direct envelope or bounded fragments. */
export function encodeUdpDataEnvelopes(
  options: UdpDataEnvelopeOptions,
): Uint8Array[] {
  if (options.payload.byteLength > UDP_MAX_PAYLOAD_BYTES) {
    throw new Error(`UDP payload exceeds ${UDP_MAX_PAYLOAD_BYTES} bytes`);
  }
  if (options.payload.byteLength <= UDP_CARRIER_FRAGMENT_PAYLOAD_BYTES) {
    return [
      encodeUdpEnvelope({
        type: "data",
        serviceId: options.serviceId,
        flowId: options.flowId,
        payload: options.payload,
      }),
    ];
  }
  const messageId = options.messageId;
  if (messageId === undefined || !Number.isSafeInteger(messageId) || messageId < 0 || messageId > 0xffff_ffff) {
    throw new Error("UDP fragmented payload requires a 32-bit message id");
  }
  const count = Math.ceil(options.payload.byteLength / UDP_FRAGMENT_DATA_BYTES);
  if (count < 2 || count > UDP_MAX_FRAGMENT_COUNT) {
    throw new Error("UDP payload fragment count is outside the supported bound");
  }
  const encoded: Uint8Array[] = [];
  for (let index = 0; index < count; index++) {
    const start = index * UDP_FRAGMENT_DATA_BYTES;
    const chunk = options.payload.subarray(
      start,
      Math.min(start + UDP_FRAGMENT_DATA_BYTES, options.payload.byteLength),
    );
    const fragment = b4a.alloc(UDP_FRAGMENT_HEADER_BYTES + chunk.byteLength);
    const view = new DataView(
      fragment.buffer,
      fragment.byteOffset,
      fragment.byteLength,
    );
    fragment[0] = 1;
    view.setUint32(1, messageId);
    view.setUint16(5, index);
    view.setUint16(7, count);
    view.setUint16(9, options.payload.byteLength);
    fragment.set(chunk, UDP_FRAGMENT_HEADER_BYTES);
    encoded.push(
      encodeUdpEnvelope({
        type: "fragment",
        serviceId: options.serviceId,
        flowId: options.flowId,
        payload: fragment,
      }),
    );
  }
  return encoded;
}

export function decodeUdpFragment(envelope: UdpEnvelope): UdpFragment {
  if (envelope.type !== "fragment") {
    throw new Error("UDP envelope is not a fragment");
  }
  if (envelope.payload.byteLength < UDP_FRAGMENT_HEADER_BYTES) {
    throw new Error("UDP fragment header is truncated");
  }
  const view = new DataView(
    envelope.payload.buffer,
    envelope.payload.byteOffset,
    envelope.payload.byteLength,
  );
  if (envelope.payload[0] !== 1) {
    throw new Error("UDP fragment version is unsupported");
  }
  const messageId = view.getUint32(1);
  const index = view.getUint16(5);
  const count = view.getUint16(7);
  const totalBytes = view.getUint16(9);
  if (
    totalBytes <= UDP_CARRIER_FRAGMENT_PAYLOAD_BYTES ||
    totalBytes > UDP_MAX_PAYLOAD_BYTES ||
    count < 2 ||
    count > UDP_MAX_FRAGMENT_COUNT ||
    count !== Math.ceil(totalBytes / UDP_FRAGMENT_DATA_BYTES) ||
    index >= count
  ) {
    throw new Error("UDP fragment metadata is invalid");
  }
  const expectedBytes = Math.min(
    UDP_FRAGMENT_DATA_BYTES,
    totalBytes - index * UDP_FRAGMENT_DATA_BYTES,
  );
  const payload = b4a.from(
    envelope.payload.subarray(UDP_FRAGMENT_HEADER_BYTES),
  );
  if (payload.byteLength !== expectedBytes) {
    throw new Error("UDP fragment payload length is invalid");
  }
  return { messageId, index, count, totalBytes, payload };
}

export interface UdpDatagramReassemblerOptions {
  now?: () => number;
  schedule?: (delayMs: number, callback: () => void) => () => void;
  timeoutMs?: number;
  maxMessages?: number;
  maxBytes?: number;
  onDrop?: (reason: string) => void;
}

interface PendingUdpDatagram {
  count: number;
  totalBytes: number;
  parts: Array<Uint8Array | undefined>;
  bytes: number;
  cancelExpiry: () => void;
}

/** Reassemble one direction of unordered fragments without adding reliability. */
export class UdpDatagramReassembler {
  private readonly schedule: (
    delayMs: number,
    callback: () => void,
  ) => () => void;
  private readonly timeoutMs: number;
  private readonly maxMessages: number;
  private readonly maxBytes: number;
  private readonly onDrop?: (reason: string) => void;
  private readonly pending = new Map<number, PendingUdpDatagram>();
  private readonly completed = new Map<number, () => void>();
  private pendingBytes = 0;

  constructor(options: UdpDatagramReassemblerOptions = {}) {
    this.schedule = options.schedule ?? defaultSchedule;
    this.timeoutMs = options.timeoutMs ?? UDP_REASSEMBLY_TIMEOUT_MS;
    this.maxMessages = options.maxMessages ?? UDP_MAX_REASSEMBLY_MESSAGES;
    this.maxBytes = options.maxBytes ?? UDP_MAX_REASSEMBLY_BYTES;
    this.onDrop = options.onDrop;
  }

  push(fragment: UdpFragment): Uint8Array | undefined {
    if (this.completed.has(fragment.messageId)) return undefined;
    let pending = this.pending.get(fragment.messageId);
    if (!pending) {
      if (
        this.pending.size >= this.maxMessages ||
        fragment.totalBytes > this.maxBytes
      ) {
        this.onDrop?.("fragment-reassembly-limit");
        return undefined;
      }
      pending = {
        count: fragment.count,
        totalBytes: fragment.totalBytes,
        parts: Array.from({ length: fragment.count }),
        bytes: 0,
        cancelExpiry: () => undefined,
      };
      this.pending.set(fragment.messageId, pending);
    } else if (
      pending.count !== fragment.count ||
      pending.totalBytes !== fragment.totalBytes
    ) {
      this.removePending(fragment.messageId, pending);
      this.onDrop?.("fragment-metadata-conflict");
      return undefined;
    }
    if (pending.parts[fragment.index] !== undefined) return undefined;
    if (this.pendingBytes + fragment.payload.byteLength > this.maxBytes) {
      this.removePending(fragment.messageId, pending);
      this.onDrop?.("fragment-reassembly-limit");
      return undefined;
    }
    pending.parts[fragment.index] = b4a.from(fragment.payload);
    pending.bytes += fragment.payload.byteLength;
    this.pendingBytes += fragment.payload.byteLength;
    pending.cancelExpiry();
    pending.cancelExpiry = this.schedule(this.timeoutMs, () => {
      if (this.pending.get(fragment.messageId) !== pending) return;
      this.removePending(fragment.messageId, pending);
      this.onDrop?.("fragment-reassembly-expired");
    });
    if (pending.bytes !== pending.totalBytes) return undefined;
    const output = b4a.alloc(pending.totalBytes);
    let offset = 0;
    for (const part of pending.parts) {
      if (part === undefined) return undefined;
      output.set(part, offset);
      offset += part.byteLength;
    }
    this.removePending(fragment.messageId, pending);
    this.markCompleted(fragment.messageId);
    return output;
  }

  clear(): void {
    for (const [messageId, pending] of this.pending) {
      this.removePending(messageId, pending);
    }
    for (const cancel of this.completed.values()) cancel();
    this.completed.clear();
  }

  private removePending(
    messageId: number,
    pending: PendingUdpDatagram,
  ): void {
    if (this.pending.get(messageId) !== pending) return;
    pending.cancelExpiry();
    this.pending.delete(messageId);
    this.pendingBytes -= pending.bytes;
  }

  private markCompleted(messageId: number): void {
    const cancel = this.schedule(this.timeoutMs, () => {
      if (this.completed.get(messageId) !== cancel) return;
      this.completed.delete(messageId);
    });
    this.completed.set(messageId, cancel);
    while (this.completed.size > UDP_MAX_REASSEMBLY_MESSAGES * 4) {
      const oldest = this.completed.keys().next().value;
      if (typeof oldest !== "number") return;
      this.completed.get(oldest)?.();
      this.completed.delete(oldest);
    }
  }
}

export interface UdpSendResult {
  ok: boolean;
  error?: string;
}

export interface UnorderedDatagramOuter {
  on: (event: "message" | "close", listener: (...args: any[]) => void) => unknown;
  off?: (event: "message" | "close", listener: (...args: any[]) => void) => unknown;
  removeListener?: (
    event: "message" | "close",
    listener: (...args: any[]) => void,
  ) => unknown;
  send?: (message: Uint8Array) => Promise<unknown> | unknown;
  rawStream?: unknown;
  destroyed?: boolean;
}

export interface RunningUdpSubscriberTransport {
  available: () => boolean;
  send: (message: Uint8Array) => Promise<UdpSendResult>;
  onMessage: (listener: (message: Uint8Array) => void) => () => void;
  onError: (listener: (error: string) => void) => () => void;
  onReset: (listener: () => void) => () => void;
  close: () => void;
}

export type SubscriberDatagramConnection = Pick<
  RunningUdpSubscriberTransport,
  "available" | "send" | "onMessage" | "onError" | "onReset"
>;

/**
 * Adapt the existing authenticated SecretStream to its unordered message API.
 * `send()` deliberately treats an undefined result as unsupported: the
 * SecretStream API uses that result both before handshake and when its raw
 * stream is not a UDX stream.
 */
export function createUdpSubscriberTransport(
  outer: UnorderedDatagramOuter,
  authorized: () => boolean = () => true,
  onError?: (error: string) => void,
): RunningUdpSubscriberTransport {
  const messageListeners = new Set<(message: Uint8Array) => void>();
  const errorListeners = new Set<(error: string) => void>();
  const resetListeners = new Set<() => void>();
  let closed = false;
  let carrierError = carrierUsabilityError(outer);

  const reportCarrierError = (error: string): void => {
    if (closed) return;
    carrierError = boundedError(error);
    for (const listener of errorListeners) {
      try {
        listener(carrierError);
      } catch {
        // Status observers cannot affect carrier forwarding.
      }
    }
  };

  const onMessage = (message: unknown): void => {
    if (closed || !(message instanceof Uint8Array)) return;
    const copy = b4a.from(message);
    for (const listener of messageListeners) {
      try {
        listener(copy);
      } catch (error) {
        onError?.(errorMessage(error));
      }
    }
  };
  const onClose = (): void => {
    if (closed) return;
    closed = true;
    for (const listener of resetListeners) {
      try {
        listener();
      } catch {
        // Reset observers are cleanup hooks and cannot keep transport alive.
      }
    }
  };

  outer.on("message", onMessage);
  outer.on("close", onClose);

  return {
    available(): boolean {
      return !closed && !carrierError && authorized() && carrierUsabilityError(outer) === undefined;
    },
    async send(message): Promise<UdpSendResult> {
      if (closed) return { ok: false, error: "UDP transport is closed" };
      if (!authorized()) {
        return { ok: false, error: "UDP service is not authorized" };
      }
      const send = outer.send;
      if (typeof send !== "function") {
        const error = "UDP datagram transport is unavailable on this connection";
        reportCarrierError(error);
        onError?.(error);
        return { ok: false, error };
      }
      let result: unknown;
      try {
        result = send.call(outer, b4a.from(message));
      } catch (error) {
        const messageText = errorMessage(error);
        reportCarrierError(messageText);
        onError?.(messageText);
        return { ok: false, error: messageText };
      }
      if (result === undefined) {
        const error = "UDP datagram transport is unavailable on this connection";
        reportCarrierError(error);
        onError?.(error);
        return { ok: false, error };
      }
      try {
        const completed = await Promise.resolve(result);
        if (completed === false) {
          const error = "UDP datagram send was rejected by the carrier";
          reportCarrierError(error);
          onError?.(error);
          return { ok: false, error };
        }
        return { ok: true };
      } catch (error) {
        const messageText = errorMessage(error);
        reportCarrierError(messageText);
        onError?.(messageText);
        return { ok: false, error: messageText };
      }
    },
    onMessage(listener): () => void {
      messageListeners.add(listener);
      return () => messageListeners.delete(listener);
    },
    onError(listener): () => void {
      errorListeners.add(listener);
      if (carrierError !== undefined) listener(carrierError);
      return () => errorListeners.delete(listener);
    },
    onReset(listener): () => void {
      resetListeners.add(listener);
      return () => resetListeners.delete(listener);
    },
    close(): void {
      if (closed) return;
      closed = true;
      removeOuterListener(outer, "message", onMessage);
      removeOuterListener(outer, "close", onClose);
      messageListeners.clear();
      errorListeners.clear();
      resetListeners.clear();
    },
  };
}

export interface UdpPublisherForwarderOptions {
  authorized: () => boolean;
  serviceAuthorized?: (serviceId: string) => boolean;
  serviceKind: (serviceId: string) => "tcp" | "http" | "udp";
  targetPort: (serviceId: string) => number | undefined;
  publisherToSubscriberRateLimiter?: (
    serviceId: string,
  ) => PublisherToSubscriberRateLimiter | undefined;
  now?: () => number;
  schedule?: (delayMs: number, callback: () => void) => () => void;
  idleTimeoutMs?: number;
  maxFlows?: number;
  maxPendingSends?: number;
  maxDatagramsPerSecond?: number;
  maxBytesPerSecond?: number;
  reassemblyTimeoutMs?: number;
  maxReassemblyMessages?: number;
  maxReassemblyBytes?: number;
  onBytes?: (
    direction: "subscriber-to-publisher" | "publisher-to-subscriber",
    bytes: number,
  ) => void;
  onError?: (error: string) => void;
  onDrop?: (reason: string, fields?: Record<string, unknown>) => void;
}

export interface RunningUdpPublisherForwarder {
  close: () => void;
  closeFlows: (serviceId?: string) => void;
  available: () => boolean;
}

interface PublisherUdpFlow {
  key: string;
  serviceId: string;
  flowId: Uint8Array;
  targetPort: number;
  socket: Socket;
  connected: boolean;
  closed: boolean;
  lastActivity: number;
  cancelExpiry?: () => void;
  pendingPayload?: Uint8Array;
  pendingSends: number;
  nextMessageId: number;
  reassembler: UdpDatagramReassembler;
}

export function createUdpPublisherForwarder(
  outer: UnorderedDatagramOuter,
  options: UdpPublisherForwarderOptions,
): RunningUdpPublisherForwarder {
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? defaultSchedule;
  const idleTimeoutMs = options.idleTimeoutMs ?? UDP_FLOW_IDLE_TIMEOUT_MS;
  const maxFlows = options.maxFlows ?? UDP_MAX_FLOWS_PER_CONNECTION;
  const maxPendingSends = options.maxPendingSends ?? UDP_MAX_PENDING_SENDS;
  const budget = new DatagramBudget(
    now,
    options.maxDatagramsPerSecond ?? UDP_MAX_DATAGRAMS_PER_SECOND,
    options.maxBytesPerSecond ?? UDP_MAX_BYTES_PER_SECOND,
  );
  const egressBudget = new DatagramBudget(
    now,
    options.maxDatagramsPerSecond ?? UDP_MAX_DATAGRAMS_PER_SECOND,
    options.maxBytesPerSecond ?? UDP_MAX_BYTES_PER_SECOND,
  );
  const carrier = createUdpSubscriberTransport(
    outer,
    () => options.authorized(),
    options.onError,
  );
  const flows = new Map<string, PublisherUdpFlow>();
  let pendingSends = 0;
  let closed = false;

  const closeFlows = (serviceId?: string): void => {
    for (const flow of [...flows.values()]) {
      if (serviceId === undefined || flow.serviceId === serviceId) {
        removeFlow(flow);
      }
    }
  };

  const unsubscribe = carrier.onMessage((message) => {
    void receive(message);
  });
  const unsubscribeReset = carrier.onReset(() => closeFlows());

  return {
    close(): void {
      if (closed) return;
      closed = true;
      unsubscribe();
      unsubscribeReset();
      closeFlows();
      carrier.close();
    },
    closeFlows,
    available: carrier.available,
  };

  async function receive(message: Uint8Array): Promise<void> {
    if (closed) return;
    let envelope: UdpEnvelope;
    try {
      envelope = decodeUdpEnvelope(message);
    } catch (error) {
      drop("malformed-envelope", { error: errorMessage(error) });
      return;
    }
    if (envelope.type === "error" || envelope.type === "close") {
      const flow = flows.get(flowKey(envelope.serviceId, envelope.flowId));
      if (flow) removeFlow(flow);
      return;
    }
    if (!budget.accept(envelope.payload.byteLength)) {
      drop("inbound-rate-limit", { serviceId: envelope.serviceId });
      return;
    }
    const kind = options.serviceKind(envelope.serviceId);
    if (
      kind !== "udp" ||
      !options.authorized() ||
      !(options.serviceAuthorized?.(envelope.serviceId) ?? true)
    ) {
      drop("unauthorized-service", { serviceId: envelope.serviceId });
      await sendError(envelope, "UDP service is not authorized");
      return;
    }
    const targetPort = options.targetPort(envelope.serviceId);
    if (targetPort === undefined) {
      drop("unmapped-service", { serviceId: envelope.serviceId });
      await sendError(envelope, "UDP service target is unavailable");
      return;
    }
    if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65_535) {
      drop("invalid-target", { serviceId: envelope.serviceId });
      await sendError(envelope, "UDP service target is invalid");
      return;
    }

    const key = flowKey(envelope.serviceId, envelope.flowId);
    let flow = flows.get(key);
    if (!flow) {
      if (flows.size >= maxFlows) {
        drop("flow-limit", { serviceId: envelope.serviceId });
        await sendError(envelope, "UDP flow limit reached");
        return;
      }
      flow = createFlow(envelope, targetPort, key);
      if (!flow) return;
      flows.set(key, flow);
    } else if (flow.targetPort !== targetPort) {
      removeFlow(flow);
      drop("stale-target", { serviceId: envelope.serviceId });
      return;
    }
    touch(flow);
    let payload = envelope.payload;
    if (envelope.type === "fragment") {
      try {
        payload = flow.reassembler.push(decodeUdpFragment(envelope)) ??
          new Uint8Array();
      } catch (error) {
        drop("malformed-fragment", { serviceId: envelope.serviceId, error: errorMessage(error) });
        return;
      }
      if (payload.byteLength === 0) return;
    }
    options.onBytes?.("subscriber-to-publisher", payload.byteLength);
    if (!flow.connected) {
      if (flow.pendingPayload !== undefined) {
        drop("flow-send-limit", { serviceId: envelope.serviceId });
        return;
      }
      flow.pendingPayload = b4a.from(payload);
      return;
    }
    sendToTarget(flow, payload);
  }

  function createFlow(
    envelope: UdpEnvelope,
    targetPort: number,
    key: string,
  ): PublisherUdpFlow | undefined {
    let socket: Socket;
    try {
      socket = createSocket("udp4");
    } catch (error) {
      reportError(`UDP target socket creation failed: ${errorMessage(error)}`);
      return undefined;
    }
    const flow: PublisherUdpFlow = {
      key,
      serviceId: envelope.serviceId,
      flowId: b4a.from(envelope.flowId),
      targetPort,
      socket,
      connected: false,
      closed: false,
      lastActivity: now(),
      pendingPayload: undefined,
      pendingSends: 0,
      nextMessageId: 0,
      reassembler: new UdpDatagramReassembler({
        now,
        schedule,
        timeoutMs: options.reassemblyTimeoutMs,
        maxMessages: options.maxReassemblyMessages,
        maxBytes: options.maxReassemblyBytes,
        onDrop: (reason) => drop(reason, { serviceId: envelope.serviceId }),
      }),
    };
    const onError = (error: Error): void => {
      if (flow.closed) return;
      reportError(`UDP target socket failed: ${error.message}`);
      removeFlow(flow);
    };
    socket.on("error", onError);
    socket.on("message", (message: Buffer, remote: RemoteInfo) => {
      if (
        flow.closed ||
        remote.address !== "127.0.0.1" ||
        remote.port !== flow.targetPort
      ) {
        drop("unexpected-target-reply", { serviceId: flow.serviceId });
        return;
      }
      touch(flow);
      void sendReply(flow, message);
    });
    try {
      socket.connect(flow.targetPort, "127.0.0.1", () => {
        if (flow.closed) return;
        flow.connected = true;
        const pending = flow.pendingPayload;
        flow.pendingPayload = undefined;
        if (pending !== undefined) sendToTarget(flow, pending);
      });
    } catch (error) {
      reportError(`UDP target connection failed: ${errorMessage(error)}`);
      flow.closed = true;
      void closeDgramSocket(socket);
      return undefined;
    }
    armExpiry(flow);
    return flow;
  }

  function sendToTarget(flow: PublisherUdpFlow, payload: Uint8Array): void {
    if (flow.closed) return;
    if (flow.pendingSends >= maxPendingSends) {
      drop("target-send-limit", { serviceId: flow.serviceId });
      return;
    }
    flow.pendingSends++;
    try {
      flow.socket.send(payload, (error) => {
        flow.pendingSends--;
        if (error && !flow.closed) {
          reportError(`UDP target send failed: ${error.message}`);
          removeFlow(flow);
        }
      });
    } catch (error) {
      flow.pendingSends--;
      reportError(`UDP target send failed: ${errorMessage(error)}`);
      removeFlow(flow);
    }
  }

  async function sendReply(flow: PublisherUdpFlow, payload: Uint8Array): Promise<void> {
    if (flow.closed) return;
    if (payload.byteLength > UDP_MAX_PAYLOAD_BYTES) {
      drop("oversize-target-reply", { serviceId: flow.serviceId });
      return;
    }
    if (!egressBudget.accept(payload.byteLength)) {
      drop("outbound-rate-limit", { serviceId: flow.serviceId });
      return;
    }
    const limiter = options.publisherToSubscriberRateLimiter?.(flow.serviceId);
    if (limiter && !limiter.tryConsume(payload.byteLength)) {
      drop("publisher-rate-limit", { serviceId: flow.serviceId });
      return;
    }
    let encoded: Uint8Array[];
    try {
      encoded = encodeUdpDataEnvelopes({
        serviceId: flow.serviceId,
        flowId: flow.flowId,
        payload,
        messageId: nextMessageId(flow),
      });
    } catch (error) {
      reportError(`UDP reply envelope failed: ${errorMessage(error)}`);
      return;
    }
    if (pendingSends + encoded.length > maxPendingSends) {
      drop("carrier-send-limit", { serviceId: flow.serviceId });
      return;
    }
    pendingSends += encoded.length;
    try {
      if (flow.closed || closed) return;
      const results = await Promise.all(encoded.map((fragment) => carrier.send(fragment)));
      for (const result of results) {
        if (!result.ok) {
          reportError(result.error ?? "UDP reply was not accepted by the carrier");
          return;
        }
      }
      options.onBytes?.("publisher-to-subscriber", payload.byteLength);
    } catch (error) {
      reportError(`UDP reply failed: ${errorMessage(error)}`);
    } finally {
      pendingSends -= encoded.length;
    }
  }

  async function sendError(envelope: UdpEnvelope, message: string): Promise<void> {
    if (closed || pendingSends >= maxPendingSends) return;
    let encoded: Uint8Array;
    try {
      encoded = encodeUdpEnvelope({
        type: "error",
        serviceId: envelope.serviceId,
        flowId: envelope.flowId,
        payload: b4a.from(message, "utf8").subarray(
          0,
          UDP_CARRIER_FRAGMENT_PAYLOAD_BYTES,
        ),
      });
    } catch {
      return;
    }
    pendingSends++;
    try {
      await carrier.send(encoded);
    } finally {
      pendingSends--;
    }
  }

  function touch(flow: PublisherUdpFlow): void {
    flow.lastActivity = now();
    armExpiry(flow);
  }

  function armExpiry(flow: PublisherUdpFlow): void {
    flow.cancelExpiry?.();
    flow.cancelExpiry = schedule(idleTimeoutMs, () => {
      if (flow.closed) return;
      if (now() - flow.lastActivity >= idleTimeoutMs) {
        removeFlow(flow);
      } else {
        armExpiry(flow);
      }
    });
  }

  function removeFlow(flow: PublisherUdpFlow): void {
    if (flow.closed) return;
    flow.closed = true;
    flow.cancelExpiry?.();
    flow.cancelExpiry = undefined;
    flow.reassembler.clear();
    flows.delete(flow.key);
    void closeDgramSocket(flow.socket);
  }

  function drop(reason: string, fields: Record<string, unknown> = {}): void {
    options.onDrop?.(reason, fields);
  }

  function reportError(message: string): void {
    options.onError?.(boundedError(message));
  }
}

export class DatagramBudget {
  private startedAt: number;
  private datagrams = 0;
  private bytes = 0;

  constructor(
    private readonly now: () => number,
    private readonly maxDatagrams: number,
    private readonly maxBytes: number,
  ) {
    this.startedAt = now();
  }

  accept(bytes: number): boolean {
    const current = this.now();
    if (current - this.startedAt >= 1_000) {
      this.startedAt = current;
      this.datagrams = 0;
      this.bytes = 0;
    }
    if (
      this.datagrams >= this.maxDatagrams ||
      this.bytes + bytes > this.maxBytes
    ) {
      return false;
    }
    this.datagrams++;
    this.bytes += bytes;
    return true;
  }
}

function flowKey(serviceId: string, flowId: Uint8Array): string {
  return `${serviceId}:${b4a.toString(flowId, "hex")}`;
}

function removeOuterListener(
  outer: UnorderedDatagramOuter,
  event: "message" | "close",
  listener: (...args: any[]) => void,
): void {
  if (outer.off) outer.off(event, listener);
  else outer.removeListener?.(event, listener);
}

function defaultSchedule(delayMs: number, callback: () => void): () => void {
  const timer = setTimeout(callback, delayMs);
  return () => clearTimeout(timer);
}

function closeDgramSocket(socket: Socket): Promise<void> {
  return new Promise((resolve) => {
    try {
      socket.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function nextMessageId(flow: { nextMessageId: number }): number {
  const messageId = flow.nextMessageId;
  flow.nextMessageId = (messageId + 1) >>> 0;
  return messageId;
}

function carrierUsabilityError(outer: UnorderedDatagramOuter): string | undefined {
  if (outer.destroyed || typeof outer.send !== "function") {
    return "UDP datagram transport is unavailable on this connection";
  }
  const raw = outer.rawStream;
  if (
    raw !== undefined &&
    (raw === null ||
      typeof raw !== "object" ||
      typeof (raw as { send?: unknown }).send !== "function")
  ) {
    return "UDP datagram transport is unavailable on this connection";
  }
  return undefined;
}

export function boundedError(error: string): string {
  return error.length <= 256 ? error : `${error.slice(0, 253)}...`;
}
