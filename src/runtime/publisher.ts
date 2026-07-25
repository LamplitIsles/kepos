import b4a from "b4a";
import { createConnection, type Socket } from "node:net";

import { startHomeServer, type RunningHomeServer } from "../home/server.js";
import {
  createDht,
  dhtStreamSnapshot,
  keyPairFromSeed,
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
  createMuxPublisher,
  type PairingDecision,
  type RunningMuxPublisher,
} from "../mux/transport.js";
import {
  PublisherPairing,
  type PublisherPairingSnapshot,
} from "../pairing/publisher.js";
import type { PairingRequest } from "../pairing/protocol.js";
import {
  loadPublisherState,
  setPublisherAllowlist,
} from "../state/publisher.js";

const maximumPairingCandidates = 3;

type SchedulePairingExpiry = (
  delayMs: number,
  callback: () => void,
) => () => void;

export interface PublisherRuntimePolicy {
  displayName: string;
  allow: string[];
  services: Array<{ id: string; name: string; targetPort: number }>;
}

export interface StartPublisherOptions {
  stateDir: string;
  bootstrap?: DhtAddress[];
  policy?: PublisherRuntimePolicy;
  log?: (line: string) => void;
  now?: () => number;
  observe?: Observe;
  persistAllowlist?: (subscriberPublicKeys: string[]) => Promise<void>;
  schedulePairingExpiry?: SchedulePairingExpiry;
}

export interface PublisherRuntimeStatus {
  role: "publisher";
  state: "running" | "stopped";
  publisherKey: string;
  homeUrl: string;
  acceptedConnections: number;
  activeSubscribers: number;
  pairing: PublisherPairingSnapshot;
}

export interface RunningPublisher {
  publisherKey: string;
  home: RunningHomeServer;
  acceptedConnections: () => number;
  activeSubscribers: () => number;
  approvePairing: () => Promise<void>;
  cancelPairing: () => void;
  createPairingInvitation: () => { uri: string; expiresAt: number };
  denyPairing: () => void;
  pairingStatus: () => PublisherPairingSnapshot;
  status: () => PublisherRuntimeStatus;
  stop: () => Promise<void>;
}

export async function startPublisher(
  options: StartPublisherOptions,
): Promise<RunningPublisher> {
  const { config, manifest } = await loadPublisherState(options.stateDir);
  const policy = options.policy ?? {
    displayName: manifest.displayName,
    allow: config.allow,
    services: manifest.services,
  };
  const keyPair = keyPairFromSeed(config.seed);
  const publisherKey = b4a.toString(keyPair.publicKey, "hex");
  const home = await startHomeServer({
    publisherKey,
    displayName: policy.displayName,
    services: policy.services.map(({ id, name }) => ({
      id,
      name,
      kind: "tcp",
    })),
  });
  const targets = new Map<string, number>([
    ["home", home.port],
    ...policy.services.map(
      (service): [string, number] => [service.id, service.targetPort],
    ),
  ]);
  const allow = new Set(policy.allow);
  const persistAllowlist =
    options.persistAllowlist ??
    (options.policy
      ? async (): Promise<void> => {
          throw new Error(
            "Publisher policy persistence is not configured for pairing",
          );
        }
      : async (subscriberPublicKeys: string[]): Promise<void> =>
          setPublisherAllowlist({
            stateDir: options.stateDir,
            subscriberPublicKeys,
          }));
  const pairing = new PublisherPairing({
    publisherKey,
    displayName: policy.displayName,
    now: options.now,
    persistSubscriber: async (subscriberKey) => {
      if (allow.has(subscriberKey)) return;
      await persistAllowlist([...allow, subscriberKey]);
    },
  });
  const dht = createDht({ bootstrap: options.bootstrap, keyPair });
  const now = options.now ?? Date.now;
  const observePairing = createObservationEmitter({
    observe: options.observe,
    role: "publisher",
    now,
  });
  const streams = new Set<DhtStream>();
  const muxes = new Map<DhtStream, RunningMuxPublisher>();
  const activeBySubscriberKey = new Map<
    string,
    {
      mux: RunningMuxPublisher;
      observe: EmitObservation;
      outerId: string;
      stream: DhtStream;
    }
  >();
  const replacedStreams = new Set<DhtStream>();
  const pairingCandidates = new Set<DhtStream>();
  let pendingCandidateAdmissions = 0;
  let cancelPairingExpiry: (() => void) | undefined;
  let accepted = 0;
  let stopped = false;

  function closePairingCandidates(): void {
    for (const stream of pairingCandidates) muxes.get(stream)?.close();
    pairingCandidates.clear();
    pendingCandidateAdmissions = 0;
  }

  function clearPairingExpiry(): void {
    cancelPairingExpiry?.();
    cancelPairingExpiry = undefined;
  }

  function reportPairingEnd(
    event: "pairing.cancelled" | "pairing.denied",
    status: PublisherPairingSnapshot,
  ): void {
    if (status.phase === "idle") return;
    observePairing(event, {
      ...(status.phase === "pending"
        ? { remotePublicKey: status.subscriberKey }
        : {}),
    });
  }

  function armPairingExpiry(expiresAt: number): void {
    clearPairingExpiry();
    const schedule = options.schedulePairingExpiry ?? schedulePairingExpiry;
    const expire = (): void => {
      const status = pairing.snapshot();
      if (status.phase !== "inviting" || status.expiresAt !== expiresAt) {
        return;
      }
      const remainingMs = expiresAt - now();
      if (remainingMs > 0) {
        cancelPairingExpiry = schedule(remainingMs, expire);
        return;
      }
      cancelPairingExpiry = undefined;
      closePairingCandidates();
      observePairing("pairing.invitation-expired", { expiresAt });
    };
    cancelPairingExpiry = schedule(Math.max(0, expiresAt - now()), expire);
  }

  const server = dht.createServer(
    {
      firewall: (remotePublicKey) => {
        const subscriberKey = b4a.toString(remotePublicKey, "hex");
        const known = allow.has(subscriberKey);
        const admitCandidate =
          pairing.acceptsCandidates() &&
          pairingCandidates.size + pendingCandidateAdmissions <
            maximumPairingCandidates;
        const rejected = !known && !admitCandidate;
        if (!known && admitCandidate) pendingCandidateAdmissions++;
        if (rejected) {
          const observe = createObservationEmitter({
            observe: options.observe,
            role: "publisher",
            outerId: createObservationId("outer"),
            now,
          });
          observe("outer.rejected", { remotePublicKey });
        }
        return rejected;
      },
      reusableSocket: true,
    },
    (stream) => {
      const subscriberKey = b4a.toString(stream.remotePublicKey, "hex");
      const initiallyAuthorized = allow.has(subscriberKey);
      if (!initiallyAuthorized && pendingCandidateAdmissions > 0) {
        pendingCandidateAdmissions--;
      }
      const outerId = createObservationId("outer");
      const observe = createObservationEmitter({
        observe: options.observe,
        role: "publisher",
        outerId,
        now,
      });
      accepted++;
      streams.add(stream);
      if (!initiallyAuthorized) pairingCandidates.add(stream);
      stream.setKeepAlive?.(10_000);
      observe("outer.accepted", {
        remotePublicKey: stream.remotePublicKey,
      });
      const reportHandshake = observeHandshake(stream, observe);
      reportHandshake();
      observe("outer.connected", {
        transport: dhtStreamSnapshot(stream),
      });
      let mux: RunningMuxPublisher | undefined;
      const activate = (): void => {
        if (!mux || !streams.has(stream)) return;
        pairingCandidates.delete(stream);
        const current = activeBySubscriberKey.get(subscriberKey);
        if (current?.stream === stream) return;
        activeBySubscriberKey.set(subscriberKey, {
          mux,
          observe,
          outerId,
          stream,
        });
        if (!current) return;
        current.observe("outer.replaced", {
          remotePublicKey: subscriberKey,
          replacementOuterId: outerId,
        });
        replacedStreams.add(current.stream);
        current.mux.close();
      };
      mux = createMuxPublisher(stream, {
        authorized: initiallyAuthorized,
        outerId,
        now,
        observe: options.observe,
        onControlReady: activate,
        ...(initiallyAuthorized
          ? {}
          : {
              onPairingRequest: (
                request: PairingRequest,
                decision: PairingDecision,
              ) => {
                const received = pairing.receive({
                  subscriberKey,
                  request,
                  approve: () => {
                    allow.add(subscriberKey);
                    activate();
                    decision.approve();
                  },
                  deny: decision.deny,
                  fail: decision.fail,
                });
                if (received) {
                  clearPairingExpiry();
                  observe("pairing.requested", {
                    remotePublicKey: subscriberKey,
                  });
                } else {
                  observe("pairing.rejected", {
                    remotePublicKey: subscriberKey,
                  });
                }
              },
            }),
        transportSnapshot: () => dhtStreamSnapshot(stream),
        connect: async (serviceId) => {
          if (activeBySubscriberKey.get(subscriberKey)?.stream !== stream) {
            throw new Error("Subscriber connection is not current");
          }
          const targetPort = targets.get(serviceId);
          if (targetPort === undefined) {
            throw new Error(`Service is not published: ${serviceId}`);
          }
          return connectLoopback(targetPort);
        },
      });
      muxes.set(stream, mux);
      if (initiallyAuthorized && !activeBySubscriberKey.has(subscriberKey)) {
        activate();
      }
      stream.once("close", () => {
        streams.delete(stream);
        muxes.delete(stream);
        pairingCandidates.delete(stream);
        const current = activeBySubscriberKey.get(subscriberKey);
        if (current?.stream === stream) {
          activeBySubscriberKey.delete(subscriberKey);
        }
        observe("outer.closed", {
          trigger: stopped
            ? "local.stop"
            : replacedStreams.delete(stream)
              ? "subscriber.replaced"
              : "stream.close",
        });
      });
    },
  );

  try {
    await server.listen(keyPair);
  } catch (error) {
    await Promise.allSettled([home.close(), dht.destroy({ force: true })]);
    throw error;
  }

  options.log?.(`Publisher ready: ${publisherKey}`);

  return {
    publisherKey,
    home,
    acceptedConnections: () => accepted,
    activeSubscribers: () => activeBySubscriberKey.size,
    approvePairing: async () => {
      const status = pairing.snapshot();
      try {
        await pairing.approve();
        observePairing("pairing.approved", {
          ...(status.phase === "pending"
            ? { remotePublicKey: status.subscriberKey }
            : {}),
        });
      } catch (error) {
        observePairing("pairing.approval-error", {
          ...(status.phase === "pending"
            ? { remotePublicKey: status.subscriberKey }
            : {}),
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
    cancelPairing: () => {
      clearPairingExpiry();
      const status = pairing.snapshot();
      pairing.cancel();
      reportPairingEnd("pairing.cancelled", status);
      closePairingCandidates();
    },
    createPairingInvitation: () => {
      if (pairing.snapshot().phase === "pending") {
        throw new Error("A pairing request is waiting for approval");
      }
      const status = pairing.snapshot();
      pairing.cancel();
      reportPairingEnd("pairing.cancelled", status);
      closePairingCandidates();
      const invitation = pairing.createInvitation();
      armPairingExpiry(invitation.expiresAt);
      observePairing("pairing.invitation-created", {
        expiresAt: invitation.expiresAt,
      });
      return invitation;
    },
    denyPairing: () => {
      clearPairingExpiry();
      const status = pairing.snapshot();
      pairing.deny();
      reportPairingEnd("pairing.denied", status);
      closePairingCandidates();
    },
    pairingStatus: () => pairing.snapshot(),
    status: () => ({
      role: "publisher",
      state: stopped ? "stopped" : "running",
      publisherKey,
      homeUrl: home.url,
      acceptedConnections: accepted,
      activeSubscribers: activeBySubscriberKey.size,
      pairing: pairing.snapshot(),
    }),
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      clearPairingExpiry();
      await pairing.waitForApproval().catch(() => undefined);
      for (const mux of muxes.values()) mux.close();
      await Promise.allSettled([
        server.close(),
        home.close(),
        dht.destroy({ force: true }),
      ]);
    },
  };
}

function schedulePairingExpiry(
  delayMs: number,
  callback: () => void,
): () => void {
  const timeout = setTimeout(callback, delayMs);
  return () => clearTimeout(timeout);
}

async function connectLoopback(port: number): Promise<Socket> {
  const socket = createConnection({
    host: "127.0.0.1",
    port,
    allowHalfOpen: true,
  });
  await new Promise<void>((resolve, reject) => {
    const onConnect = (): void => {
      socket.off("error", onError);
      resolve();
    };
    const onError = (error: Error): void => {
      socket.off("connect", onConnect);
      reject(error);
    };
    socket.once("connect", onConnect);
    socket.once("error", onError);
  });
  return socket;
}

function observeHandshake(
  stream: DhtStream,
  observe: ReturnType<typeof createObservationEmitter>,
): () => void {
  let reported = false;
  const report = (): void => {
    if (reported) return;
    reported = true;
    observe("outer.handshake", {
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
