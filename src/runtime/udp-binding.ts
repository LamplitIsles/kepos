import b4a from "b4a";
import crypto from "hypercore-crypto";
import { createSocket, type RemoteInfo, type Socket } from "node:dgram";

import {
  boundedError,
  decodeUdpEnvelope,
  decodeUdpFragment,
  encodeUdpDataEnvelopes,
  nextMessageId,
  DatagramBudget,
  UdpDatagramReassembler,
  UDP_FLOW_IDLE_TIMEOUT_MS,
  UDP_FLOW_ID_BYTES,
  UDP_MAX_BYTES_PER_SECOND,
  UDP_MAX_DATAGRAMS_PER_SECOND,
  UDP_MAX_FLOWS_PER_CONNECTION,
  UDP_MAX_PAYLOAD_BYTES,
  UDP_MAX_PENDING_SENDS,
  type SubscriberDatagramConnection,
  type UdpEnvelope,
} from "../mux/udp.js";

export interface RunningPeerUdpBinding {
  kind: "udp";
  port: number;
  setConnection: (
    connection: SubscriberDatagramConnection | undefined,
    generation?: number,
  ) => void;
  close: () => Promise<void>;
}

export interface PeerUdpBindingOptions {
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

interface BindingFlow {
  key: string;
  flowId: Uint8Array;
  sourceAddress: string;
  sourcePort: number;
  generation: number;
  lastActivity: number;
  closed: boolean;
  cancelExpiry?: () => void;
  nextMessageId: number;
  localReassembler: UdpDatagramReassembler;
  remoteReassembler: UdpDatagramReassembler;
}

/**
 * Consume a configured local UDP port and put its datagrams on the currently
 * authenticated dial-side UDP carrier.  The transport is replaceable so a
 * reconnect cannot deliver a reply to a flow belonging to an old generation.
 */
export async function listenPeerUdpBinding(
  serviceId: string,
  port: number,
  options: PeerUdpBindingOptions = {},
): Promise<RunningPeerUdpBinding> {
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
  const flowsBySource = new Map<string, BindingFlow>();
  const flowsById = new Map<string, BindingFlow>();
  let connection: SubscriberDatagramConnection | undefined;
  let generation = 0;
  let unsubscribeMessage: (() => void) | undefined;
  let unsubscribeReset: (() => void) | undefined;
  let pendingSends = 0;
  let closed = false;
  let bound = false;

  socket.on("error", (error: Error) => {
    if (bound && !closed) reportError(`Local UDP binding failed: ${error.message}`);
  });
  socket.on("message", (message: Buffer, remote: RemoteInfo) => {
    void receiveLocal(message, remote);
  });

  try {
    await bind(socket, port);
    bound = true;
  } catch (error) {
    await closeSocket(socket);
    throw new Error(`Unable to bind local UDP service ${serviceId}: ${errorMessage(error)}`, { cause: error });
  }
  const address = socket.address();
  if (!address || typeof address === "string") {
    await closeSocket(socket);
    throw new Error(`Local UDP ${serviceId} binding address is unavailable`);
  }

  return {
    kind: "udp",
    port: address.port,
    setConnection(nextConnection, nextGeneration = generation + 1): void {
      if (closed) return;
      if (nextConnection === connection && nextGeneration === generation) return;
      unsubscribeMessage?.();
      unsubscribeReset?.();
      unsubscribeMessage = undefined;
      unsubscribeReset = undefined;
      clearFlows();
      connection = nextConnection;
      generation = nextGeneration;
      if (!nextConnection) return;
      const boundGeneration = generation;
      unsubscribeMessage = nextConnection.onMessage((message) => {
        if (boundGeneration === generation && nextConnection === connection) {
          void receiveRemote(message, nextConnection, boundGeneration);
        }
      });
      unsubscribeReset = nextConnection.onReset(() => {
        if (boundGeneration !== generation || nextConnection !== connection) return;
        clearFlows();
        reportError("UDP binding connection was reset; local flows will reopen");
      });
    },
    close: async () => {
      if (closed) return;
      closed = true;
      unsubscribeMessage?.();
      unsubscribeReset?.();
      unsubscribeMessage = undefined;
      unsubscribeReset = undefined;
      connection = undefined;
      clearFlows();
      await closeSocket(socket);
    },
  };

  async function receiveLocal(message: Buffer, remote: RemoteInfo): Promise<void> {
    if (closed || remote.address !== "127.0.0.1") return;
    if (message.byteLength > UDP_MAX_PAYLOAD_BYTES) {
      drop("oversize-local-datagram");
      return;
    }
    if (!budget.accept(message.byteLength)) {
      drop("local-rate-limit");
      return;
    }
    const currentConnection = connection;
    const currentGeneration = generation;
    if (!currentConnection || !currentConnection.available()) {
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
        generation: currentGeneration,
        lastActivity: now(),
        closed: false,
        nextMessageId: 0,
        localReassembler: new UdpDatagramReassembler({
          now,
          schedule,
          timeoutMs: options.reassemblyTimeoutMs,
          maxMessages: options.maxReassemblyMessages,
          maxBytes: options.maxReassemblyBytes,
          onDrop: (reason) => drop(reason),
        }),
        remoteReassembler: new UdpDatagramReassembler({
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
    } else if (flow.generation !== currentGeneration) {
      removeFlow(flow);
      drop("stale-generation");
      return;
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
      if (connection !== currentConnection || generation !== currentGeneration || flow.closed) return;
      const results = await Promise.all(encoded.map((fragment) => currentConnection.send(fragment)));
      if (connection !== currentConnection || generation !== currentGeneration || flow.closed) return;
      for (const result of results) {
        if (!result.ok) reportError(result.error ?? "UDP datagram was dropped");
      }
    } finally {
      pendingSends -= encoded.length;
    }
  }

  async function receiveRemote(
    message: Uint8Array,
    currentConnection: SubscriberDatagramConnection,
    currentGeneration: number,
  ): Promise<void> {
    if (closed || connection !== currentConnection || generation !== currentGeneration) return;
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
    if (!flow || flow.closed || flow.generation !== currentGeneration) {
      drop("unknown-flow");
      return;
    }
    touch(flow);
    if (envelope.type === "error") {
      reportError(`Peer rejected UDP flow: ${b4a.toString(envelope.payload, "utf8")}`);
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
        const reassembled = flow.remoteReassembler.push(decodeUdpFragment(envelope));
        if (reassembled === undefined) return;
        payload = reassembled;
      } catch (error) {
        drop("malformed-fragment", { error: errorMessage(error) });
        return;
      }
    }
    if (pendingSends >= maxPendingSends || !egressBudget.accept(payload.byteLength)) {
      drop("local-reply-limit");
      return;
    }
    pendingSends++;
    try {
      await new Promise<void>((resolve) => {
        try {
          socket.send(payload, flow.sourcePort, flow.sourceAddress, (error) => {
            if (error) reportError(`Local UDP reply failed: ${error.message}`);
            resolve();
          });
        } catch (error) {
          reportError(`Local UDP reply failed: ${errorMessage(error)}`);
          resolve();
        }
      });
    } finally {
      pendingSends--;
    }
  }

  function touch(flow: BindingFlow): void {
    flow.lastActivity = now();
    armExpiry(flow);
  }

  function armExpiry(flow: BindingFlow): void {
    flow.cancelExpiry?.();
    flow.cancelExpiry = schedule(idleTimeoutMs, () => {
      if (flow.closed) return;
      if (now() - flow.lastActivity >= idleTimeoutMs) removeFlow(flow);
      else armExpiry(flow);
    });
  }

  function removeFlow(flow: BindingFlow): void {
    if (flow.closed) return;
    flow.closed = true;
    flow.cancelExpiry?.();
    flow.cancelExpiry = undefined;
    flow.localReassembler.clear();
    flow.remoteReassembler.clear();
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

function bind(socket: Socket, port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      socket.off("error", onError);
      reject(error);
    };
    const onListening = (): void => {
      socket.off("error", onError);
      resolve();
    };
    socket.once("error", onError);
    socket.once("listening", onListening);
    socket.bind(port, "127.0.0.1");
  });
}

function closeSocket(socket: Socket): Promise<void> {
  return new Promise<void>((resolve) => {
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
