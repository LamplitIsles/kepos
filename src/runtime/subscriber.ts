import {
  createServer,
  type Server,
  type Socket,
} from "node:net";
import type { Duplex } from "node:stream";

import { startHttpGateway } from "../home/gateway.js";
import {
  CancellationController,
  type CancellationSignal,
} from "./cancellation.js";
import {
  createDht,
  dhtStatsSnapshot,
  dhtStreamSnapshot,
  holepunchObservation,
  keyPairFromSecretKey,
  type DhtAddress,
  type DhtStream,
} from "../mux/hyperdht.js";
import {
  createObservationEmitter,
  createObservationId,
  type EmitObservation,
  type Observe,
} from "../mux/observability.js";
import {
  connectionOptionsForRoute,
  type Route,
} from "../mux/route.js";
import {
  createMuxSubscriber,
  TerminalPairingError,
  type RunningMuxSubscriber,
} from "../mux/transport.js";
import { parsePairingInvitation } from "../pairing/invitation.js";
import type { PairingRequest } from "../pairing/protocol.js";
import {
  loadSubscriberConnectionState,
  promoteSubscriberPendingPublisher,
  setSubscriberPendingPublisher,
} from "../state/subscriber.js";

export interface SubscriberService {
  id: string;
  localPort: number;
}

export interface RunningSubscriberService {
  id: string;
  port: number;
}

export interface StartSubscriberOptions {
  stateDir: string;
  bootstrap?: DhtAddress[];
  gatewayPort?: number;
  gatewayHost?: string;
  gatewayDomain?: string;
  serviceAcquisitionTimeoutMs?: number;
  services: SubscriberService[];
  log?: (line: string) => void;
  now?: () => number;
  observe?: Observe;
  onTerminalConnectionError?: (error: Error) => void;
  pairing?: {
    invitation: string;
    deviceLabel: string;
    platform: string;
    onStatus?: (status: "awaiting-approval" | "approved") => void;
  };
  route?: Route;
  sleep?: (delayMs: number) => Promise<void>;
  waitForPublisher?: boolean;
}

export type SubscriberConnectionStatus =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "stopped";

export interface SubscriberRuntimeStatus {
  role: "subscriber";
  state: "running" | "stopped";
  connection: SubscriberConnectionStatus;
  connectionGeneration: number;
  publisherKey: string;
  homeUrl: string;
  services: RunningSubscriberService[];
}

export interface RunningSubscriber {
  publisherKey: string;
  home: {
    port: number;
    url: string;
  };
  services: RunningSubscriberService[];
  status: () => SubscriberRuntimeStatus;
  stop: () => Promise<void>;
}

interface ServiceOpener {
  open: (serviceId: string, signal?: CancellationSignal) => Promise<Duplex>;
}

type ScheduleConnectTimeout = (
  delayMs: number,
  onTimeout: () => void,
) => () => void;

const defaultConnectTimeoutMs = 20_000;

export async function startSubscriber(
  options: StartSubscriberOptions,
): Promise<RunningSubscriber> {
  let pairingRequest: PairingRequest | undefined;
  let pairingExpiresAt: number | undefined;
  if (options.pairing) {
    const invitation = parsePairingInvitation(options.pairing.invitation, {
      now: options.now,
    });
    await setSubscriberPendingPublisher({
      stateDir: options.stateDir,
      label: invitation.displayName,
      publisherKey: invitation.publisherKey,
    });
    pairingRequest = {
      token: invitation.token,
      label: options.pairing.deviceLabel,
      platform: options.pairing.platform,
    };
    pairingExpiresAt = invitation.expiresAt;
  }
  const { contact, identity, pending } =
    await loadSubscriberConnectionState(options.stateDir);
  const keyPair = keyPairFromSecretKey(identity.secretKey);
  const dht = createDht({ bootstrap: options.bootstrap, keyPair });
  const now = options.now ?? Date.now;
  const route = options.route ?? "auto";
  const connection = createPublisherConnection({
    connect: (observe) =>
      dht.connect(Buffer.from(contact.publisherKey, "hex"), {
        keyPair,
        ...connectionOptionsForRoute(route),
        holepunch: (
          remoteFirewall,
          localFirewall,
          remoteAddresses,
          localAddresses,
        ) => {
          observe(
            "outer.holepunch",
            holepunchObservation(
              remoteFirewall,
              localFirewall,
              remoteAddresses,
              localAddresses,
            ),
          );
          return true;
        },
      }),
    dhtStats: () => dhtStatsSnapshot(dht),
    log: options.log,
    now,
    observe: options.observe,
    onTerminalConnectionError: options.onTerminalConnectionError,
    ...(pairingRequest && pairingExpiresAt !== undefined
      ? {
          pairing: {
            request: pairingRequest,
            expiresAt: pairingExpiresAt,
            onPending: () => options.pairing?.onStatus?.("awaiting-approval"),
            onApproved: async () => {
              await promoteSubscriberPendingPublisher(options.stateDir);
              options.pairing?.onStatus?.("approved");
            },
          },
        }
      : {}),
    ...(pending && !pairingRequest
      ? {
          pendingApproval: {
            onConfirmed: () =>
              promoteSubscriberPendingPublisher(options.stateDir),
          },
        }
      : {}),
    route,
    sleep: options.sleep ?? delay,
  });
  const servers: Server[] = [];
  let stopped = false;

  try {
    if (options.waitForPublisher ?? true) {
      await connection.start();
    }

    const gateway = await startHttpGateway({
      port: options.gatewayPort ?? (contact.requestedLocalPort || undefined),
      host: options.gatewayHost,
      domain: options.gatewayDomain,
      acquisitionTimeoutMs: options.serviceAcquisitionTimeoutMs,
      open: connection.open,
    });
    servers.push(gateway.server);
    const services: RunningSubscriberService[] = [];
    for (const service of options.services) {
      const listener = await listenSubscriberService(
        service.id,
        service.localPort,
        connection,
        options.serviceAcquisitionTimeoutMs ?? 10_000,
      );
      servers.push(listener.server);
      services.push({ id: service.id, port: listener.port });
    }
    if (options.waitForPublisher === false) {
      connection.startInBackground();
    }

    options.log?.(`Local HTTP gateway ready @${gateway.url}`);
    for (const service of services) {
      options.log?.(`Local ${service.id} ready @127.0.0.1:${service.port}`);
    }

    return {
      publisherKey: contact.publisherKey,
      home: {
        port: gateway.port,
        url: gateway.url,
      },
      services,
      status: () => ({
        role: "subscriber",
        state: stopped ? "stopped" : "running",
        connection: connection.status(),
        connectionGeneration: connection.generation(),
        publisherKey: contact.publisherKey,
        homeUrl: gateway.url,
        services: services.map((service) => ({ ...service })),
      }),
      async stop(): Promise<void> {
        if (stopped) return;
        stopped = true;
        await connection.stop();
        await Promise.allSettled(servers.map(closeServer));
        await dht.destroy({ force: true });
      },
    };
  } catch (error) {
    await connection.stop();
    await Promise.allSettled([
      ...servers.map(closeServer),
      dht.destroy({ force: true }),
    ]);
    throw error;
  }
}

export async function listenSubscriberService(
  serviceId: string,
  port: number,
  connection: ServiceOpener,
  acquisitionTimeoutMs: number,
): Promise<{ port: number; server: Server }> {
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    socket.pause();
    void openAndBridge(
      socket,
      connection,
      serviceId,
      acquisitionTimeoutMs,
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error(`Local ${serviceId} listener address is unavailable`);
  }
  return { port: address.port, server };
}

async function openAndBridge(
  socket: Socket,
  connection: ServiceOpener,
  serviceId: string,
  acquisitionTimeoutMs: number,
): Promise<void> {
  const abort = new CancellationController();
  const timeout = setTimeout(() => {
    abort.abort();
    socket.destroy();
  }, acquisitionTimeoutMs);
  socket.once("close", () => abort.abort());
  try {
    const tunnel = await connection.open(serviceId, abort.signal);
    if (socket.destroyed) {
      tunnel.destroy();
      return;
    }
    socket.pipe(tunnel);
    tunnel.pipe(socket);
    socket.once("error", (error) => tunnel.destroy(error));
    tunnel.once("error", (error) => socket.destroy(error));
    socket.once("close", () => tunnel.destroy());
    tunnel.once("close", () => socket.destroy());
    socket.resume();
  } catch {
    socket.destroy();
  } finally {
    clearTimeout(timeout);
  }
}

export function createPublisherConnection(options: {
  connect: (observe: EmitObservation) => DhtStream;
  connectTimeoutMs?: number;
  createMuxSubscriber?: typeof createMuxSubscriber;
  dhtStats?: () => unknown;
  log?: (line: string) => void;
  now: () => number;
  observe?: Observe;
  onTerminalConnectionError?: (error: Error) => void;
  pairing?: {
    request: PairingRequest;
    expiresAt: number;
    onPending?: () => void;
    onApproved: () => Promise<void>;
  };
  pendingApproval?: {
    onConfirmed: () => Promise<void>;
  };
  route: Route;
  scheduleConnectTimeout?: ScheduleConnectTimeout;
  sleep: (delayMs: number) => Promise<void>;
}): ServiceOpener & {
  start: () => Promise<void>;
  startInBackground: () => void;
  generation: () => number;
  status: () => SubscriberConnectionStatus;
  stop: () => Promise<void>;
} {
  let current:
    | { mux: RunningMuxSubscriber; outer: DhtStream }
    | undefined;
  let reconnecting: Promise<RunningMuxSubscriber> | undefined;
  let connectingOuter: DhtStream | undefined;
  let stopped = false;
  let pairing = options.pairing;
  let pairingRequestAccepted = false;
  let pendingApproval = options.pendingApproval;
  let connectionAttempt = 0;
  let connectionGeneration = 0;

  const install = (
    outer: DhtStream,
    mux: RunningMuxSubscriber,
    observe: EmitObservation,
  ): RunningMuxSubscriber => {
    current = { outer, mux };
    connectionGeneration++;
    let streamError: string | undefined;
    outer.once("error", (error) => {
      streamError = error.message;
    });
    outer.once("close", () => {
      if (current?.outer !== outer) return;
      current = undefined;
      observe("outer.closed", {
        trigger: stopped
          ? "local.stop"
          : streamError
            ? "stream.error"
            : "stream.close",
        ...(streamError ? { error: streamError } : {}),
        ...(options.dhtStats ? { dht: options.dhtStats() } : {}),
      });
      if (!stopped) {
        options.log?.("Publisher connection closed; reconnecting");
        void reconnect().catch(() => undefined);
      }
    });
    return mux;
  };

  const connectOnce = async (
    onFailure?: (observe: EmitObservation) => void,
  ): Promise<{
    mux: RunningMuxSubscriber;
    observe: EmitObservation;
  }> => {
    if (
      pairing &&
      !pairingRequestAccepted &&
      options.now() >= pairing.expiresAt
    ) {
      throw new Error("Pairing invitation has expired");
    }
    const attempt = ++connectionAttempt;
    const attemptStartedAt = options.now();
    const outerId = createObservationId("outer");
    const observe = createObservationEmitter({
      observe: options.observe,
      role: "subscriber",
      outerId,
      now: options.now,
      route: options.route,
    });
    observe("outer.attempt", { attempt });
    const outer = options.connect(observe);
    connectingOuter = outer;
    const reportHandshake = observeHandshake(
      outer,
      observe,
      attempt,
      attemptStartedAt,
      options.now,
    );
    try {
      await waitForConnect(
        outer,
        options.connectTimeoutMs ?? defaultConnectTimeoutMs,
        options.scheduleConnectTimeout ?? scheduleConnectTimeout,
      );
      if (stopped) {
        outer.destroy();
        throw new Error("Subscriber stopped");
      }
      outer.setKeepAlive?.(10_000);
      reportHandshake();
      observe("outer.connected", {
        attempt,
        attemptElapsedMs: options.now() - attemptStartedAt,
        transport: dhtStreamSnapshot(outer),
        ...(options.dhtStats ? { dht: options.dhtStats() } : {}),
      });
      const activePairing = pairingRequestAccepted ? undefined : pairing;
      const activePendingApproval = pairingRequestAccepted
        ? pairing
          ? { onConfirmed: pairing.onApproved }
          : undefined
        : activePairing
          ? undefined
          : pendingApproval;
      let controlReadyResolve: (() => void) | undefined;
      let controlReadyReject: ((error: Error) => void) | undefined;
      const controlReady = activePendingApproval
        ? new Promise<void>((resolve, reject) => {
            controlReadyResolve = resolve;
            controlReadyReject = reject;
          })
        : undefined;
      const mux = (options.createMuxSubscriber ?? createMuxSubscriber)(outer, {
        authorized: activePairing === undefined,
        outerId,
        now: options.now,
        observe: options.observe,
        onControlClosed: () =>
          controlReadyReject?.(
            new Error("Publisher did not authorize the pending subscriber"),
          ),
        onControlReady: () => controlReadyResolve?.(),
        onHeartbeatTimeout: (fields) => {
          observe("outer.unhealthy", {
            reason: "heartbeat.timeout",
            ...fields,
          });
        },
        transportSnapshot: () => dhtStreamSnapshot(outer),
      });
      if (activePairing) {
        await mux.pair(activePairing.request, {
          onPending: () => {
            pairingRequestAccepted = true;
            activePairing.onPending?.();
          },
        });
        await activePairing.onApproved();
        if (pairing === activePairing) pairing = undefined;
      } else if (activePendingApproval && controlReady) {
        await controlReady;
        await activePendingApproval.onConfirmed();
        if (pairingRequestAccepted && pairing) {
          pairing = undefined;
          pairingRequestAccepted = false;
        } else if (pendingApproval === activePendingApproval) {
          pendingApproval = undefined;
        }
      }
      return { observe, mux: install(outer, mux, observe) };
    } catch (error) {
      const failure = stopped
        ? new Error("Subscriber stopped")
        : error instanceof Error
          ? error
          : new Error(String(error));
      observe("outer.closed", {
        trigger: "connect.error",
        error: failure.message,
        attempt,
        attemptElapsedMs: options.now() - attemptStartedAt,
        ...(options.dhtStats ? { dht: options.dhtStats() } : {}),
      });
      onFailure?.(observe);
      outer.destroy();
      throw failure;
    } finally {
      if (connectingOuter === outer) connectingOuter = undefined;
    }
  };

  const reconnect = (): Promise<RunningMuxSubscriber> => {
    if (current) return Promise.resolve(current.mux);
    if (reconnecting) return reconnecting;
    reconnecting = (async () => {
      let delayMs = 100;
      const recoveryStartedAt = options.now();
      let recoveryAttempt = 0;
      while (!stopped) {
        recoveryAttempt++;
        let failedAttemptObserve: EmitObservation | undefined;
        try {
          const { mux, observe } = await connectOnce((failedObserve) => {
            failedAttemptObserve = failedObserve;
          });
          options.log?.("Publisher connection restored");
          observe("outer.restored", {
            recoveryAttempt,
            recoveryElapsedMs: options.now() - recoveryStartedAt,
          });
          return mux;
        } catch (error) {
          if (stopped) throw error;
          if (error instanceof TerminalPairingError) throw error;
          if (
            pairing &&
            !pairingRequestAccepted &&
            options.now() >= pairing.expiresAt
          ) {
            throw error;
          }
          const message =
            error instanceof Error ? error.message : String(error);
          failedAttemptObserve?.("outer.retry", {
            recoveryAttempt,
            delayMs,
            error: message,
            recoveryElapsedMs: options.now() - recoveryStartedAt,
          });
          options.log?.(
            `Publisher reconnect failed; retrying: ${message}`,
          );
          await options.sleep(delayMs);
          delayMs = Math.min(delayMs * 2, 2_000);
        }
      }
      throw new Error("Subscriber stopped");
    })().finally(() => {
      reconnecting = undefined;
    });
    return reconnecting;
  };

  return {
    async start(): Promise<void> {
      await connectOnce();
    },
    startInBackground(): void {
      if (stopped || current || reconnecting) return;
      void reconnect().catch((error) => {
        if (stopped) return;
        options.onTerminalConnectionError?.(
          error instanceof Error ? error : new Error(String(error)),
        );
      });
    },
    generation(): number {
      return connectionGeneration;
    },
    async open(serviceId: string, signal?: CancellationSignal): Promise<Duplex> {
      while (!stopped) {
        throwIfAborted(signal);
        const activeConnection = current;
        const active = activeConnection?.mux ??
          (await waitWithAbort(reconnect(), signal));
        throwIfAborted(signal);
        try {
          return await openWithAbort(active.open(serviceId), signal);
        } catch (error) {
          if (
            current?.mux === active &&
            !activeConnection?.outer.destroyed
          ) {
            throw error;
          }
          await options.sleep(10);
        }
      }
      throw new Error("Subscriber stopped");
    },
    status(): SubscriberConnectionStatus {
      if (stopped) return "stopped";
      if (current) return "connected";
      if (reconnecting) return "reconnecting";
      return "connecting";
    },
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      connectingOuter?.destroy();
      current?.mux.close();
      current = undefined;
      await reconnecting?.catch(() => undefined);
    },
  };
}

function throwIfAborted(signal?: CancellationSignal): void {
  if (signal?.aborted) throw new Error("Service open aborted");
}

async function waitWithAbort<T>(
  pending: Promise<T>,
  signal?: CancellationSignal,
): Promise<T> {
  if (!signal) return pending;
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(new Error("Service open aborted"));
    };
    signal.addEventListener("abort", onAbort);
    pending.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function openWithAbort(
  pending: Promise<Duplex>,
  signal?: CancellationSignal,
): Promise<Duplex> {
  if (!signal) return pending;
  try {
    return await waitWithAbort(pending, signal);
  } catch (error) {
    if (signal.aborted) {
      void pending.then((stream) => stream.destroy(), () => undefined);
    }
    throw error;
  }
}

function observeHandshake(
  stream: DhtStream,
  observe: EmitObservation,
  attempt: number,
  attemptStartedAt: number,
  now: () => number,
): () => void {
  let reported = false;
  const report = (): void => {
    if (reported) return;
    reported = true;
    observe("outer.handshake", {
      attempt,
      attemptElapsedMs: now() - attemptStartedAt,
      transport: dhtStreamSnapshot(stream),
    });
  };
  if (stream.connected) {
    report();
    return report;
  }
  stream.once("handshake", report);
  return report;
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function waitForConnect(
  stream: DhtStream,
  timeoutMs: number,
  scheduleTimeout: ScheduleConnectTimeout,
): Promise<void> {
  if (stream.connected) return;
  requirePositiveTimeout(timeoutMs);
  await new Promise<void>((resolve, reject) => {
    let cancelTimeout = (): void => undefined;
    const cleanup = (): void => {
      cancelTimeout();
      stream.off("connect", onConnect);
      stream.off("error", onError);
      stream.off("close", onClose);
    };
    cancelTimeout = scheduleTimeout(timeoutMs, () => {
      cleanup();
      reject(new Error(`Publisher connection timed out after ${timeoutMs}ms`));
    });
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
      reject(new Error("Publisher connection closed before handshake"));
    };
    stream.once("connect", onConnect);
    stream.once("error", onError);
    stream.once("close", onClose);
  });
}

function scheduleConnectTimeout(
  delayMs: number,
  onTimeout: () => void,
): () => void {
  const timeout = setTimeout(onTimeout, delayMs);
  return () => clearTimeout(timeout);
}

function requirePositiveTimeout(timeoutMs: number): void {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("connect timeout must be a positive finite number");
  }
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
