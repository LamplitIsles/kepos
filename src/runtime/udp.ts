import { createSocket, type RemoteInfo, type Socket } from "node:dgram";

import b4a from "b4a";
import crypto from "hypercore-crypto";

import {
  decodeUdpEnvelope,
  encodeUdpDataEnvelopes,
  decodeUdpFragment,
  DatagramBudget,
  UDP_FLOW_IDLE_TIMEOUT_MS,
  UDP_FLOW_ID_BYTES,
  UDP_MAX_DATAGRAMS_PER_SECOND,
  UDP_MAX_FLOWS_PER_CONNECTION,
  UDP_MAX_PAYLOAD_BYTES,
  UDP_MAX_PENDING_SENDS,
  UDP_MAX_BYTES_PER_SECOND,
  UdpDatagramReassembler,
  type SubscriberDatagramConnection,
  type UdpEnvelope,
} from "../mux/udp.js";

export interface RunningSubscriberUdpListener {
  kind: "udp";
  port: number;
  close: () => Promise<void>;
}

export interface ListenSubscriberUdpServiceOptions {
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
  onError?: (error: string) => void;
  onDrop?: (reason: string, fields?: Record<string, unknown>) => void;
}

interface SubscriberUdpFlow {
  key: string;
  flowId: Uint8Array;
  sourceAddress: string;
  sourcePort: number;
  lastActivity: number;
  closed: boolean;
  cancelExpiry?: () => void;
  nextMessageId: number;
  reassembler: UdpDatagramReassembler;
}

export async function listenSubscriberUdpService(
  serviceId: string,
  port: number,
  connection: SubscriberDatagramConnection | undefined,
  options: ListenSubscriberUdpServiceOptions = {},
): Promise<RunningSubscriberUdpListener> {
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
  const socket = createSocket("udp4");
  const flowsBySource = new Map<string, SubscriberUdpFlow>();
  const flowsById = new Map<string, SubscriberUdpFlow>();
  let pendingSends = 0;
  let closed = false;
  let bound = false;

  const onSocketError = (error: Error): void => {
    if (!bound || closed) return;
    reportError(`Local UDP listener failed: ${error.message}`);
  };
  socket.on("error", onSocketError);
  socket.on("message", (message: Buffer, remote: RemoteInfo) => {
    void receiveLocal(message, remote);
  });

  const unsubscribeMessage = connection?.onMessage((message) => {
    void receiveRemote(message);
  });
  const unsubscribeReset = connection?.onReset(() => {
    clearFlows();
    reportError("UDP outer connection replaced; local flows will reopen");
  });

  try {
    await bind(socket, port);
    bound = true;
  } catch (error) {
    unsubscribeMessage?.();
    unsubscribeReset?.();
    await closeSocket(socket);
    throw new Error(
      `Unable to bind local UDP service ${serviceId}: ${errorMessage(error)}`,
      { cause: error },
    );
  }

  const address = socket.address();
  if (!address || typeof address === "string") {
    await closeSocket(socket);
    throw new Error(`Local UDP ${serviceId} listener address is unavailable`);
  }

  return {
    kind: "udp",
    port: address.port,
    close: async () => {
      if (closed) return;
      closed = true;
      unsubscribeMessage?.();
      unsubscribeReset?.();
      clearFlows();
      await closeSocket(socket);
    },
  };

  async function receiveLocal(
    message: Buffer,
    remote: RemoteInfo,
  ): Promise<void> {
    if (closed || remote.address !== "127.0.0.1") return;
    if (message.byteLength > UDP_MAX_PAYLOAD_BYTES) {
      drop("oversize-local-datagram");
      return;
    }
    if (!budget.accept(message.byteLength)) {
      drop("local-rate-limit");
      return;
    }
    if (!connection) {
      reportError("UDP datagram transport is unavailable on this connection");
      return;
    }
    if (!connection.available()) {
      reportError("UDP datagram transport is unavailable on this connection");
      return;
    }
    const sourceKey = `${remote.address}:${remote.port}`;
    let flow = flowsBySource.get(sourceKey);
    if (!flow) {
      if (flowsBySource.size >= maxFlows) {
        drop("flow-limit");
        return;
      }
      const flowId = crypto.randomBytes(UDP_FLOW_ID_BYTES);
      flow = {
        key: `${serviceId}:${sourceKey}`,
        flowId,
        sourceAddress: remote.address,
        sourcePort: remote.port,
        lastActivity: now(),
        closed: false,
        nextMessageId: 0,
        reassembler: new UdpDatagramReassembler({
          now,
          schedule,
          timeoutMs: options.reassemblyTimeoutMs,
          maxMessages: options.maxReassemblyMessages,
          maxBytes: options.maxReassemblyBytes,
          onDrop: (reason) => drop(reason),
        }),
      };
      flowsBySource.set(sourceKey, flow);
      flowsById.set(flowKey(serviceId, flowId), flow);
    }
    touch(flow);
    let encoded: Uint8Array[];
    try {
      encoded = encodeUdpDataEnvelopes({
        serviceId,
        flowId: flow.flowId,
        payload: message,
        messageId: nextMessageId(flow),
      });
    } catch (error) {
      reportError(`UDP datagram envelope failed: ${errorMessage(error)}`);
      return;
    }
    if (pendingSends + encoded.length > maxPendingSends) {
      drop("carrier-send-limit");
      return;
    }
    pendingSends += encoded.length;
    try {
      const results = await Promise.all(encoded.map((fragment) => connection.send(fragment)));
      for (const result of results) {
        if (!result.ok) reportError(result.error ?? "UDP datagram was dropped");
      }
    } finally {
      pendingSends -= encoded.length;
    }
  }

  async function receiveRemote(message: Uint8Array): Promise<void> {
    if (closed) return;
    let envelope: UdpEnvelope;
    try {
      envelope = decodeUdpEnvelope(message);
    } catch (error) {
      drop("malformed-envelope", { error: errorMessage(error) });
      return;
    }
    if (envelope.serviceId !== serviceId) {
      drop("wrong-service");
      return;
    }
    const flow = flowsById.get(flowKey(serviceId, envelope.flowId));
    if (!flow || flow.closed) {
      drop("unknown-flow");
      return;
    }
    touch(flow);
    if (envelope.type === "error") {
      reportError(
        `Publisher rejected UDP flow: ${b4a.toString(envelope.payload, "utf8")}`,
      );
      removeFlow(flow);
      return;
    }
    if (envelope.type === "close") {
      removeFlow(flow);
      return;
    }
    let payload = envelope.payload;
    if (envelope.type === "fragment") {
      try {
        payload = flow.reassembler.push(decodeUdpFragment(envelope)) ??
          new Uint8Array();
      } catch (error) {
        drop("malformed-fragment", { error: errorMessage(error) });
        return;
      }
      if (payload.byteLength === 0) return;
    }
    if (pendingSends >= maxPendingSends) {
      drop("local-reply-limit");
      return;
    }
    if (!egressBudget.accept(payload.byteLength)) {
      drop("local-rate-limit");
      return;
    }
    pendingSends++;
    try {
      await new Promise<void>((resolve) => {
        try {
          socket.send(
            payload,
            flow.sourcePort,
            flow.sourceAddress,
            (error) => {
              if (error) reportError(`Local UDP reply failed: ${error.message}`);
              resolve();
            },
          );
        } catch (error) {
          reportError(`Local UDP reply failed: ${errorMessage(error)}`);
          resolve();
        }
      });
    } finally {
      pendingSends--;
    }
  }

  function touch(flow: SubscriberUdpFlow): void {
    flow.lastActivity = now();
    armExpiry(flow);
  }

  function armExpiry(flow: SubscriberUdpFlow): void {
    flow.cancelExpiry?.();
    flow.cancelExpiry = schedule(idleTimeoutMs, () => {
      if (flow.closed) return;
      if (now() - flow.lastActivity >= idleTimeoutMs) removeFlow(flow);
      else armExpiry(flow);
    });
  }

  function removeFlow(flow: SubscriberUdpFlow): void {
    if (flow.closed) return;
    flow.closed = true;
    flow.cancelExpiry?.();
    flow.cancelExpiry = undefined;
    flow.reassembler.clear();
    flowsBySource.delete(`${flow.sourceAddress}:${flow.sourcePort}`);
    flowsById.delete(flowKey(serviceId, flow.flowId));
  }

  function clearFlows(): void {
    for (const flow of [...flowsBySource.values()]) removeFlow(flow);
  }

  function reportError(message: string): void {
    options.onError?.(boundedError(message));
  }

  function drop(reason: string, fields: Record<string, unknown> = {}): void {
    options.onDrop?.(reason, fields);
  }
}

async function bind(socket: Socket, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      socket.off("error", onError);
      reject(error);
    };
    socket.once("error", onError);
    socket.bind(port, "127.0.0.1", () => {
      socket.off("error", onError);
      resolve();
    });
  });
}

async function closeSocket(socket: Socket): Promise<void> {
  await new Promise<void>((resolve) => {
    try {
      socket.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

function flowKey(serviceId: string, flowId: Uint8Array): string {
  return `${serviceId}:${b4a.toString(flowId, "hex")}`;
}

function defaultSchedule(delayMs: number, callback: () => void): () => void {
  const timer = setTimeout(callback, delayMs);
  return () => clearTimeout(timer);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function boundedError(error: string): string {
  return error.length <= 256 ? error : `${error.slice(0, 253)}...`;
}

function nextMessageId(flow: { nextMessageId: number }): number {
  const messageId = flow.nextMessageId;
  flow.nextMessageId = (messageId + 1) >>> 0;
  return messageId;
}
