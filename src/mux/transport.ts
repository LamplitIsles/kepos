import compactModule from "compact-encoding";
import b4a from "b4a";
import crypto from "hypercore-crypto";
import { Duplex } from "node:stream";
import ProtomuxModule from "protomux";

import {
  pairingRequestEncoding,
  pairingResponseEncoding,
  type PairingRequest,
  type PairingResponse,
} from "../pairing/protocol.js";
import {
  createObservationId,
  createObservationEmitter,
  type EmitObservation,
  type ObservationDirection,
  type ObservationFields,
  type ObservationRole,
  type Observe,
} from "./observability.js";

const Protomux = ProtomuxModule as ProtomuxConstructor;
const compact = compactModule as CompactEncoding;

const protocol = "kepos/tcp/1";
const controlProtocol = "kepos/control/1";
const pairingProtocol = "kepos/pair/1";
const defaultControlEstablishmentTimeoutMs = 20_000;
const defaultHeartbeatIntervalMs = 15_000;
const defaultHeartbeatResponseTimeoutMs = 10_000;
const defaultMissedPongsBeforeTimeout = 2;

interface Encoding<T> {
  decode: (state: unknown) => T;
  encode: (state: unknown, value: T) => void;
  preencode: (state: unknown, value: T) => void;
}

interface CompactEncoding {
  buffer: Encoding<Uint8Array>;
  none: Encoding<null>;
  string: Encoding<string>;
}

interface OuterStream extends NodeJS.ReadWriteStream {
  destroy: (error?: Error) => void;
  destroyed?: boolean;
  userData?: unknown;
}

interface MuxMessage<T> {
  send: (value: T) => boolean;
}

interface MuxChannel {
  addMessage: <T>(options: {
    encoding: Encoding<T>;
    onmessage: (message: T) => void;
  }) => MuxMessage<T>;
  close: () => void;
  open: (handshake: string) => void;
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
  pair: (
    options: { protocol: string },
    callback: (id: Uint8Array) => void | Promise<void>,
  ) => void;
  unpair: (options: { protocol: string }) => void;
}

interface ProtomuxConstructor {
  new (stream: OuterStream): MuxInstance;
}

interface TunnelMessages {
  data: MuxMessage<Uint8Array>;
  fin: MuxMessage<null>;
  pause: MuxMessage<null>;
  reset: MuxMessage<string>;
  resume: MuxMessage<null>;
  status: MuxMessage<string>;
}

interface ControlMessages {
  ping: MuxMessage<string>;
  pong: MuxMessage<string>;
}

type ScheduleHeartbeat = (
  delayMs: number,
  callback: () => void,
) => () => void;

export interface HeartbeatOptions {
  establishmentTimeoutMs?: number;
  intervalMs?: number;
  missedPongsBeforeTimeout?: number;
  responseTimeoutMs?: number;
  schedule?: ScheduleHeartbeat;
}

export interface MuxPublisherOptions {
  authorized?: boolean;
  connect: (serviceId: string) => Promise<Duplex>;
  heartbeat?: false;
  now?: () => number;
  onControlReady?: () => void;
  onPairingRequest?: (
    request: PairingRequest,
    decision: PairingDecision,
  ) => void | Promise<void>;
  observe?: Observe;
  outerId?: string;
  schedulePairingRequestDeadline?: ScheduleHeartbeat;
  transportSnapshot?: () => unknown;
}

export interface MuxSubscriberOptions {
  authorized?: boolean;
  heartbeat?: false | HeartbeatOptions;
  now?: () => number;
  onControlClosed?: () => void;
  onControlEstablishmentTimeout?: () => void;
  onControlReady?: () => void;
  onControlUnexpectedClose?: () => void;
  onHeartbeatTimeout?: (fields: {
    lastPongElapsedMs: number;
    missedPongs: number;
  }) => void;
  observe?: Observe;
  outerId?: string;
  transportSnapshot?: () => unknown;
}

export interface RunningMuxPublisher {
  close: () => void;
}

export interface RunningMuxSubscriber {
  close: () => void;
  controlReady?: Promise<ControlNegotiation>;
  open: (serviceId: string) => Promise<Duplex>;
  pair: (
    request: PairingRequest,
    options?: { onPending?: () => void },
  ) => Promise<void>;
}

export type ControlNegotiation = "disabled" | "legacy" | "ready";

export interface PairingDecision {
  approve: () => void;
  deny: () => void;
  fail: (
    code: Extract<PairingResponse, { status: "error" }>["code"],
  ) => void;
}

export type TerminalPairingOutcome =
  | "denied"
  | Extract<PairingResponse, { status: "error" }>["code"];

export class TerminalPairingError extends Error {
  readonly outcome: TerminalPairingOutcome;

  constructor(outcome: TerminalPairingOutcome) {
    super(
      outcome === "denied"
        ? "Pairing request was denied"
        : `Pairing failed: ${outcome}`,
    );
    this.name = "TerminalPairingError";
    this.outcome = outcome;
  }
}

interface RunningControlChannel {
  close: () => void;
  ready: Promise<ControlNegotiation>;
}

function scheduleHeartbeat(
  delayMs: number,
  callback: () => void,
): () => void {
  const timeout = setTimeout(callback, delayMs);
  return () => clearTimeout(timeout);
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && (value ?? 0) > 0 ? value! : fallback;
}

function createSubscriberControlChannel(
  mux: MuxInstance,
  outer: OuterStream,
  options: MuxSubscriberOptions,
  now: () => number,
): RunningControlChannel {
  if (options.heartbeat === false) {
    return { close: () => undefined, ready: Promise.resolve("disabled") };
  }

  const heartbeat = options.heartbeat ?? {};
  const establishmentTimeoutMs = positiveInteger(
    heartbeat.establishmentTimeoutMs,
    defaultControlEstablishmentTimeoutMs,
  );
  const intervalMs = positiveInteger(
    heartbeat.intervalMs,
    defaultHeartbeatIntervalMs,
  );
  const responseTimeoutMs = positiveInteger(
    heartbeat.responseTimeoutMs,
    defaultHeartbeatResponseTimeoutMs,
  );
  const missedPongsBeforeTimeout = positiveInteger(
    heartbeat.missedPongsBeforeTimeout,
    defaultMissedPongsBeforeTimeout,
  );
  const schedule = heartbeat.schedule ?? scheduleHeartbeat;
  let cancelTimer: (() => void) | undefined;
  let closed = false;
  let opened = false;
  let outerClosed = false;
  let outerErrored = false;
  let locallyClosing = false;
  let lastPongAt = now();
  let missedPongs = 0;
  let pendingSequence: string | undefined;
  let sequence = 0;
  let messages: ControlMessages;
  let readyResolve!: (result: ControlNegotiation) => void;
  let readyReject!: (error: Error) => void;
  let readySettled = false;
  const ready = new Promise<ControlNegotiation>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  void ready.catch(() => undefined);

  const channel = mux.createChannel({
    protocol: controlProtocol,
    id: crypto.randomBytes(16),
    handshake: compact.string,
    onopen: () => {
      if (closed) return;
      opened = true;
      settleReady("ready");
      options.onControlReady?.();
      sendPing();
    },
    onclose: (isRemote) => {
      const wasOpened = opened;
      finish();
      options.onControlClosed?.();
      if (locallyClosing) return;
      if (!wasOpened) {
        if (!isRemote) {
          settleFailure(new Error("Subscriber control channel closed"));
          return;
        }
        queueMicrotask(() => {
          if (readySettled) return;
          if (outerClosed || outerErrored || outer.destroyed) {
            settleFailure(
              new Error("Publisher connection closed before control was ready"),
            );
            return;
          }
          settleReady("legacy");
        });
        return;
      }
      if (!isRemote) return;
      queueMicrotask(() => {
        if (outerClosed || outer.destroyed || locallyClosing) return;
        options.onControlUnexpectedClose?.();
        outer.destroy(new Error("Publisher control channel closed unexpectedly"));
      });
    },
  });
  if (!channel) {
    settleFailure(new Error("Subscriber control channel could not be created"));
    return { close: () => undefined, ready };
  }

  messages = {
    ping: channel.addMessage({
      encoding: compact.string,
      onmessage: () => undefined,
    }),
    pong: channel.addMessage({
      encoding: compact.string,
      onmessage: receivePong,
    }),
  };
  outer.once("close", () => {
    outerClosed = true;
    if (!readySettled) {
      settleFailure(
        new Error("Publisher connection closed before control was ready"),
      );
    }
    finish();
  });
  outer.once("error", () => {
    outerErrored = true;
    if (readySettled) return;
    settleFailure(
      new Error("Publisher connection errored before control was ready"),
    );
    finish();
  });
  arm(establishmentTimeoutMs, establishmentTimedOut);
  channel.open("1");

  return { close: stop, ready };

  function arm(delayMs: number, callback: () => void): void {
    cancelTimer?.();
    cancelTimer = schedule(delayMs, callback);
  }

  function sendPing(): void {
    if (closed) return;
    pendingSequence = String(++sequence);
    messages.ping.send(pendingSequence);
    arm(responseTimeoutMs, missPong);
  }

  function establishmentTimedOut(): void {
    if (closed || opened) return;
    const error = new Error(
      `Publisher control channel timed out after ${establishmentTimeoutMs}ms`,
    );
    options.onControlEstablishmentTimeout?.();
    settleFailure(error);
    finish();
    destroyOuter(error);
  }

  function receivePong(receivedSequence: string): void {
    if (closed || receivedSequence !== pendingSequence) return;
    pendingSequence = undefined;
    missedPongs = 0;
    lastPongAt = now();
    arm(intervalMs, sendPing);
  }

  function missPong(): void {
    if (closed) return;
    pendingSequence = undefined;
    missedPongs++;
    if (missedPongs < missedPongsBeforeTimeout) {
      sendPing();
      return;
    }
    options.onHeartbeatTimeout?.({
      lastPongElapsedMs: Math.max(0, now() - lastPongAt),
      missedPongs,
    });
    finish();
    destroyOuter(
      new Error(
        `Publisher heartbeat timed out after ${missedPongs} missed replies`,
      ),
    );
  }

  function stop(): void {
    locallyClosing = true;
    if (!readySettled) {
      settleFailure(new Error("Subscriber control channel closed"));
    }
    finish();
    channel?.close();
  }

  function finish(): void {
    if (closed) return;
    closed = true;
    pendingSequence = undefined;
    cancelTimer?.();
    cancelTimer = undefined;
  }

  function settleReady(result: ControlNegotiation): void {
    if (readySettled) return;
    readySettled = true;
    readyResolve(result);
  }

  function settleFailure(error: Error): void {
    if (readySettled) return;
    readySettled = true;
    readyReject(error);
  }

  function destroyOuter(error: Error): void {
    if (outer.destroyed) return;
    outer.destroy(error);
  }
}

function pairPublisherControlChannel(
  mux: MuxInstance,
  options: MuxPublisherOptions,
): Set<MuxChannel> {
  const channels = new Set<MuxChannel>();
  if (options.heartbeat === false) return channels;

  mux.pair({ protocol: controlProtocol }, (id) => {
    let messages: ControlMessages;
    const channel = mux.createChannel({
      protocol: controlProtocol,
      id,
      handshake: compact.string,
      onopen: () => options.onControlReady?.(),
      onclose: () => {
        if (channel) channels.delete(channel);
      },
    });
    if (!channel) return;
    channels.add(channel);
    messages = {
      ping: channel.addMessage({
        encoding: compact.string,
        onmessage: (receivedSequence) =>
          messages.pong.send(receivedSequence),
      }),
      pong: channel.addMessage({
        encoding: compact.string,
        onmessage: () => undefined,
      }),
    };
    channel.open("1");
  });
  return channels;
}

class MuxTunnel extends Duplex {
  readonly ready: Promise<void>;

  private channel?: MuxChannel;
  private messages?: TunnelMessages;
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  private readyState: "pending" | "ready" | "failed" = "pending";
  private localPaused = false;
  private remotePaused = false;
  private pendingWrite?: {
    chunk: Uint8Array;
    callback: (error?: Error | null) => void;
  };
  private pendingDrain?: (error?: Error | null) => void;
  private remoteClosing = false;
  private closeTrigger = "local.close";
  private readonly openedAt: number;
  private readonly metrics: Record<
    ObservationDirection,
    {
      bytes: number;
      firstByteAt?: number;
      lastByteAt?: number;
    }
  > = {
    "subscriber-to-publisher": { bytes: 0 },
    "publisher-to-subscriber": { bytes: 0 },
  };

  constructor(
    private readonly options: {
      emit: EmitObservation;
      incomingDirection: ObservationDirection;
      measure: boolean;
      now: () => number;
      outgoingDirection: ObservationDirection;
      transportSnapshot?: () => unknown;
    },
  ) {
    super({ allowHalfOpen: true });
    this.openedAt = options.now();
    this.ready = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
  }

  attach(channel: MuxChannel, messages: TunnelMessages): void {
    this.channel = channel;
    this.messages = messages;
  }

  accept(): void {
    if (this.readyState !== "pending") return;
    this.readyState = "ready";
    this.readyResolve();
  }

  reject(message: string): void {
    if (this.readyState !== "pending") return;
    this.readyState = "failed";
    const error = new Error(message);
    this.readyReject(error);
    this.remoteClosing = true;
    this.closeTrigger = "remote.open-error";
    this.destroy();
  }

  receive(chunk: Uint8Array): void {
    if (this.destroyed) return;
    this.observeBytes(this.options.incomingDirection, chunk);
    if (!this.push(b4a.from(chunk)) && !this.localPaused) {
      this.localPaused = true;
      this.options.emit("channel.pause", {
        direction: this.options.incomingDirection,
        source: "local",
      });
      this.messages?.pause.send(null);
    }
  }

  receiveFin(): void {
    this.options.emit("channel.fin", {
      direction: this.options.incomingDirection,
      source: "remote",
    });
    if (!this.destroyed) this.push(null);
  }

  receivePause(): void {
    this.remotePaused = true;
    this.options.emit("channel.pause", {
      direction: this.options.outgoingDirection,
      source: "remote",
    });
  }

  receiveResume(): void {
    this.remotePaused = false;
    this.options.emit("channel.resume", {
      direction: this.options.outgoingDirection,
      source: "remote",
    });
    this.flushPendingWrite();
  }

  receiveReset(message: string): void {
    this.remoteClosing = true;
    this.closeTrigger = "remote.reset";
    this.options.emit("channel.reset", {
      direction: this.options.incomingDirection,
      error: message || "Remote tunnel reset",
      source: "remote",
    });
    this.destroy(new Error(message || "Remote tunnel reset"));
  }

  remoteClose(): void {
    this.remoteClosing = true;
    this.closeTrigger = "remote.close";
    if (this.readyState === "pending") {
      this.reject("Remote closed the tunnel before it opened");
      return;
    }
    this.destroy();
  }

  outerDrain(): void {
    const callback = this.pendingDrain;
    this.pendingDrain = undefined;
    callback?.();
  }

  closeFrom(trigger: string, error?: Error): void {
    if (this.destroyed) return;
    this.closeTrigger = trigger;
    this.destroy(error);
  }

  override _read(): void {
    if (!this.localPaused) return;
    this.localPaused = false;
    this.options.emit("channel.resume", {
      direction: this.options.incomingDirection,
      source: "local",
    });
    this.messages?.resume.send(null);
  }

  override _write(
    data: Uint8Array,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const copy = b4a.from(data as Uint8Array);
    if (this.remotePaused) {
      this.pendingWrite = { chunk: copy, callback };
      return;
    }
    this.sendData(copy, callback);
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.options.emit("channel.fin", {
      direction: this.options.outgoingDirection,
      source: "local",
    });
    this.messages?.fin.send(null);
    callback();
  }

  override _destroy(
    error: Error | null,
    callback: (error?: Error | null) => void,
  ): void {
    if (this.readyState === "pending") {
      this.readyState = "failed";
      this.readyReject(error ?? new Error("Tunnel closed before it opened"));
    }
    if (!this.remoteClosing && error) {
      if (this.closeTrigger === "local.close") {
        this.closeTrigger = "local.error";
      }
      this.options.emit("channel.reset", {
        direction: this.options.outgoingDirection,
        error: error.message,
        source: "local",
      });
      this.messages?.reset.send(error.message);
    }
    this.options.emit("channel.close", {
      trigger: this.closeTrigger,
      ...(error ? { error: error.message } : {}),
      durationMs: this.options.now() - this.openedAt,
      ...this.transferFields(),
      ...transportFields(this.options.transportSnapshot),
    });
    this.channel?.close();
    callback(error);
  }

  private sendData(
    chunk: Uint8Array,
    callback: (error?: Error | null) => void,
  ): void {
    this.observeBytes(this.options.outgoingDirection, chunk);
    if (!this.messages?.data.send(chunk)) {
      this.pendingDrain = callback;
      return;
    }
    callback();
  }

  private flushPendingWrite(): void {
    const pending = this.pendingWrite;
    if (!pending) return;
    this.pendingWrite = undefined;
    this.sendData(pending.chunk, pending.callback);
  }

  private observeBytes(
    direction: ObservationDirection,
    chunk: Uint8Array,
  ): void {
    if (!this.options.measure) return;
    const observedAt = this.options.now();
    const metric = this.metrics[direction];
    metric.bytes += chunk.byteLength;
    metric.lastByteAt = observedAt;
    if (metric.firstByteAt !== undefined) return;
    metric.firstByteAt = observedAt;
    this.options.emit("channel.first-byte", {
      direction,
      bytes: chunk.byteLength,
    });
  }

  private transferFields(): ObservationFields {
    return {
      ...directionFields(
        "subscriberToPublisher",
        this.openedAt,
        this.metrics["subscriber-to-publisher"],
      ),
      ...directionFields(
        "publisherToSubscriber",
        this.openedAt,
        this.metrics["publisher-to-subscriber"],
      ),
    };
  }
}

export function createMuxSubscriber(
  outer: OuterStream,
  options: MuxSubscriberOptions = {},
): RunningMuxSubscriber {
  const mux = new Protomux(outer);
  const now = options.now ?? Date.now;
  const outerId = options.outerId ?? createObservationId("outer");
  let authorized = options.authorized ?? true;
  let control: RunningControlChannel | undefined;
  let controlReadyResolve!: (result: ControlNegotiation) => void;
  let controlReadyReject!: (error: Error) => void;
  let controlReadySettled = false;
  const controlReady = new Promise<ControlNegotiation>((resolve, reject) => {
    controlReadyResolve = resolve;
    controlReadyReject = reject;
  });
  void controlReady.catch(() => undefined);
  let pairingChannel: MuxChannel | undefined;

  const startControl = (): void => {
    control = createSubscriberControlChannel(mux, outer, options, now);
    void control.ready.then(resolveControlReady, rejectControlReady);
  };

  const resolveControlReady = (result: ControlNegotiation): void => {
    if (controlReadySettled) return;
    controlReadySettled = true;
    controlReadyResolve(result);
  };

  const rejectControlReady = (error: Error): void => {
    if (controlReadySettled) return;
    controlReadySettled = true;
    controlReadyReject(error);
  };

  if (authorized) startControl();

  const authorize = (): void => {
    if (authorized) return;
    authorized = true;
    startControl();
  };

  return {
    controlReady,
    async open(serviceId: string): Promise<Duplex> {
      if (!authorized) {
        throw new Error("Subscriber pairing is not approved");
      }
      const id = crypto.randomBytes(16);
      const emit = createObservationEmitter({
        observe: options.observe,
        role: "subscriber",
        outerId,
        channelId: b4a.toString(id, "hex"),
        serviceId,
        now,
      });
      const tunnel = createTunnel(
        mux,
        id,
        "subscriber",
        emit,
        options.observe !== undefined,
        now,
        options.transportSnapshot,
        (status) => {
          if (status === "") {
            tunnel.stream.accept();
            emit("channel.open-ok", transportFields(options.transportSnapshot));
          } else {
            emit("channel.open-error", {
              error: status,
              ...transportFields(options.transportSnapshot),
            });
            tunnel.stream.reject(status);
          }
        },
      );
      emit("channel.open");
      tunnel.channel.open(serviceId);
      await tunnel.stream.ready;
      return tunnel.stream;
    },
    pair(
      request: PairingRequest,
      pairingOptions: { onPending?: () => void } = {},
    ): Promise<void> {
      if (authorized) {
        throw new Error("Subscriber is already approved");
      }
      if (pairingChannel) {
        throw new Error("Subscriber pairing is already in progress");
      }
      return new Promise<void>((resolve, reject) => {
        let settled = false;
        const channel = mux.createChannel({
          protocol: pairingProtocol,
          id: crypto.randomBytes(16),
          handshake: compact.string,
          onopen: () => {
            requestMessage.send(request);
          },
          onclose: () => {
            pairingChannel = undefined;
            if (settled) return;
            settled = true;
            reject(new Error("Pairing channel closed before approval"));
          },
        });
        if (!channel) {
          reject(new Error("Pairing channel could not be created"));
          return;
        }
        const requestMessage = channel.addMessage({
          encoding: pairingRequestEncoding,
          onmessage: () => undefined,
        });
        channel.addMessage({
          encoding: pairingResponseEncoding,
          onmessage: (response) => {
            if (settled) return;
            if (response.status === "pending") {
              pairingOptions.onPending?.();
              return;
            }
            settled = true;
            if (response.status === "approved") {
              authorize();
              resolve();
              return;
            }
            reject(
              new TerminalPairingError(
                response.status === "denied" ? "denied" : response.code,
              ),
            );
          },
        });
        pairingChannel = channel;
        channel.open("");
      });
    },
    close(): void {
      pairingChannel?.close();
      if (!control) {
        rejectControlReady(
          new Error("Subscriber closed before control was ready"),
        );
      }
      control?.close();
      outer.destroy();
    },
  };
}

function pairPublisherServiceProtocol(
  mux: MuxInstance,
  options: MuxPublisherOptions,
  now: () => number,
  outerId: string,
): void {
  mux.pair({ protocol }, (id) => {
    let serviceId: string | undefined;
    const emitBase = createObservationEmitter({
      observe: options.observe,
      role: "publisher",
      outerId,
      channelId: b4a.toString(id, "hex"),
      now,
    });
    const emit: EmitObservation = (event, fields = {}) =>
      emitBase(event, {
        ...(serviceId ? { serviceId } : {}),
        ...fields,
      });
    const tunnel = createTunnel(
      mux,
      id,
      "publisher",
      emit,
      options.observe !== undefined,
      now,
      options.transportSnapshot,
      () => undefined,
      async (openedServiceId) => {
        serviceId = openedServiceId;
        emit("channel.open");
        try {
          const target = await options.connect(openedServiceId);
          tunnel.stream.accept();
          tunnel.messages.status.send("");
          emit("channel.open-ok", transportFields(options.transportSnapshot));
          bridge(tunnel.stream, target);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          tunnel.stream.accept();
          tunnel.messages.status.send(message);
          emit("channel.open-error", {
            error: message,
            ...transportFields(options.transportSnapshot),
          });
          queueMicrotask(() => tunnel.channel.close());
        }
      },
    );
    tunnel.channel.open("");
  });
}

export function createMuxPublisher(
  outer: OuterStream,
  options: MuxPublisherOptions,
): RunningMuxPublisher {
  const mux = new Protomux(outer);
  const now = options.now ?? Date.now;
  const outerId = options.outerId ?? createObservationId("outer");
  let authorized = false;
  let pairingChannel: MuxChannel | undefined;
  let pairingOpened = false;
  const controlChannels = new Set<MuxChannel>();

  const installAuthorizedProtocols = (): void => {
    if (authorized) return;
    authorized = true;
    for (const channel of pairPublisherControlChannel(mux, options)) {
      controlChannels.add(channel);
    }
    pairPublisherServiceProtocol(mux, options, now, outerId);
  };

  if (options.authorized ?? true) installAuthorizedProtocols();

  if (options.onPairingRequest) {
    mux.pair({ protocol: pairingProtocol }, (id) => {
      if (authorized || pairingOpened) {
        outer.destroy(new Error("Pairing candidate opened an invalid channel"));
        return;
      }
      pairingOpened = true;
      let received = false;
      let decided = false;
      let cancelDeadline: (() => void) | undefined;
      const channel = mux.createChannel({
        protocol: pairingProtocol,
        id,
        handshake: compact.string,
        onopen: () => {
          cancelDeadline = (
            options.schedulePairingRequestDeadline ?? scheduleHeartbeat
          )(5_000, () => {
            outer.destroy(new Error("Pairing request deadline exceeded"));
          });
        },
        onclose: () => {
          cancelDeadline?.();
          cancelDeadline = undefined;
          pairingChannel = undefined;
        },
      });
      if (!channel) {
        outer.destroy(new Error("Pairing channel could not be created"));
        return;
      }
      let responseMessage: MuxMessage<PairingResponse>;
      channel.addMessage({
        encoding: pairingRequestEncoding,
        onmessage: (request) => {
          if (received) {
            outer.destroy(new Error("Pairing request was already submitted"));
            return;
          }
          received = true;
          cancelDeadline?.();
          cancelDeadline = undefined;
          responseMessage.send({ status: "pending" });
          const decision: PairingDecision = {
            approve(): void {
              if (decided) return;
              decided = true;
              installAuthorizedProtocols();
              responseMessage.send({ status: "approved" });
              queueMicrotask(() => channel.close());
            },
            deny(): void {
              if (decided) return;
              decided = true;
              responseMessage.send({ status: "denied" });
              queueMicrotask(() => outer.destroy());
            },
            fail(code): void {
              if (decided) return;
              decided = true;
              responseMessage.send({ status: "error", code });
              queueMicrotask(() => outer.destroy());
            },
          };
          Promise.resolve(options.onPairingRequest?.(request, decision)).catch(
            () => decision.fail("invalid-request"),
          );
        },
      });
      responseMessage = channel.addMessage({
        encoding: pairingResponseEncoding,
        onmessage: () => undefined,
      });
      pairingChannel = channel;
      channel.open("");
    });
  }

  return {
    close(): void {
      mux.unpair({ protocol });
      mux.unpair({ protocol: controlProtocol });
      mux.unpair({ protocol: pairingProtocol });
      pairingChannel?.close();
      for (const channel of controlChannels) channel.close();
      controlChannels.clear();
      outer.destroy();
    },
  };
}

function createTunnel(
  mux: MuxInstance,
  id: Uint8Array,
  role: ObservationRole,
  emit: EmitObservation,
  measure: boolean,
  now: () => number,
  transportSnapshot: (() => unknown) | undefined,
  onStatus: (status: string) => void,
  onOpen?: (serviceId: string) => void | Promise<void>,
): { channel: MuxChannel; messages: TunnelMessages; stream: MuxTunnel } {
  const stream = new MuxTunnel({
    emit,
    measure,
    now,
    incomingDirection:
      role === "subscriber"
        ? "publisher-to-subscriber"
        : "subscriber-to-publisher",
    outgoingDirection:
      role === "subscriber"
        ? "subscriber-to-publisher"
        : "publisher-to-subscriber",
    transportSnapshot,
  });
  const channel = mux.createChannel({
    protocol,
    id,
    handshake: compact.string,
    onopen: onOpen,
    onclose: () => stream.remoteClose(),
    ondrain: () => stream.outerDrain(),
  });
  if (!channel) {
    throw new Error("Unable to create multiplex channel");
  }

  const messages: TunnelMessages = {
    status: channel.addMessage({
      encoding: compact.string,
      onmessage: onStatus,
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
  return { channel, messages, stream };
}

function transportFields(
  snapshot: (() => unknown) | undefined,
): ObservationFields {
  if (!snapshot) return {};
  try {
    const transport = snapshot();
    return transport === undefined ? {} : { transport };
  } catch {
    return {};
  }
}

function bridge(tunnel: MuxTunnel, target: Duplex): void {
  tunnel.pipe(target);
  target.pipe(tunnel);
  tunnel.once("error", (error) => target.destroy(error));
  target.once("error", (error) => tunnel.closeFrom("target.error", error));
  tunnel.once("close", () => target.destroy());
  target.once("close", () => tunnel.closeFrom("target.close"));
}

function directionFields(
  prefix: "subscriberToPublisher" | "publisherToSubscriber",
  openedAt: number,
  metric: {
    bytes: number;
    firstByteAt?: number;
    lastByteAt?: number;
  },
): ObservationFields {
  const fields: ObservationFields = {
    [`${prefix}Bytes`]: metric.bytes,
  };
  if (
    metric.firstByteAt === undefined ||
    metric.lastByteAt === undefined
  ) {
    return fields;
  }
  const transferMs = metric.lastByteAt - metric.firstByteAt;
  return {
    ...fields,
    [`${prefix}FirstByteMs`]: metric.firstByteAt - openedAt,
    [`${prefix}TransferMs`]: transferMs,
    [`${prefix}BytesPerSecond`]: Math.round(
      (metric.bytes * 1_000) / Math.max(1, transferMs),
    ),
  };
}
