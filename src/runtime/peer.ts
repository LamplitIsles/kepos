import b4a from "b4a";
import crypto from "hypercore-crypto";
import { once } from "node:events";
import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net";
import { lstat, unlink } from "node:fs/promises";
import process from "node:process";
import type { Duplex } from "node:stream";

import {
  startHttpGateway,
  DEFAULT_GATEWAY_PORT,
  type RunningHttpGateway,
} from "../home/gateway.js";
import type { HomeRegistry } from "../home/registry.js";
import {
  createDht,
  dhtStatsSnapshot,
  dhtStreamSnapshot,
  holepunchObservation,
  keyPairFromSeed,
  type DhtAddress,
  type DhtNode,
  type DhtStream,
} from "../mux/hyperdht.js";
import {
  createMuxPeer,
  type MuxPeerOptions,
  type PeerCapability,
  type RunningMuxPeer,
} from "../mux/transport.js";
import {
  createObservationEmitter,
  createObservationId,
  type Observe,
} from "../mux/observability.js";
import { connectionOptionsForRoute } from "../mux/route.js";
import { TokenBucketRateLimiter } from "../mux/rate-limit.js";
import {
  boundedError,
  decodeUdpEnvelope,
  decodeUdpFragment,
  encodeUdpDataEnvelopes,
  encodeUdpEnvelope,
  UdpDatagramReassembler,
  type UdpEnvelope,
  type UdpPublisherRemote,
  type UdpSendResult,
} from "../mux/udp.js";
import {
  PublisherPairing,
  type PublisherPairingSnapshot,
} from "../pairing/publisher.js";
import { parsePairingInvitation } from "../pairing/invitation.js";
import type { PairingRequest } from "../pairing/protocol.js";
import type {
  PeerBinding,
  PeerConfig,
  PeerDefinition,
  PeerService,
  PeerServiceSource,
} from "../config.js";
import { peerBindingKind } from "../config.js";
import {
  createServicePresentation,
  type LocalServiceMapping,
  type ServicePresentation,
} from "../services/presentation.js";
import {
  createPeerMetricsRecorder,
  peerMetricsPolicy,
  type PeerMetricsRecorder,
} from "../metrics/peer.js";
import {
  startMetricsServer,
  type MetricsListenAddress,
  type RunningMetricsServer,
} from "../metrics/server.js";
import {
  listenPeerUdpBinding,
  type RunningPeerUdpBinding,
} from "./udp-binding.js";
import { loadPeerIdentity } from "../state/peer.js";
import {
  CancellationController,
  type CancellationSignal,
} from "./cancellation.js";
import { cleanupAll } from "./cleanup.js";
import { readHomeRegistryFromConnection } from "./registry-client.js";

const defaultConnectTimeoutMs = 20_000;
const defaultServiceAcquisitionTimeoutMs = 10_000;
const minimumReconnectDelayMs = 100;
const maximumReconnectDelayMs = 2_000;
const catalogRefreshIntervalMs = 1_000;

export type PeerConnectionStatus =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "offline"
  | "stopped";

export interface PeerRuntimeConnectionStatus {
  label: string;
  publicKey: string;
  connection: PeerDefinition["connection"];
  status: PeerConnectionStatus;
  generation: number;
  capability: PeerCapability | "pending";
  services: number;
  error?: string;
}

export interface PeerRuntimeServiceStatus {
  id: string;
  name: string;
  kind: PeerService["kind"];
  source: PeerServiceSource;
  available: boolean;
  access: ServicePresentation["access"];
  action: ServicePresentation["action"];
  icon: ServicePresentation["icon"];
  url?: string;
  copyText?: string;
  peer?: string;
  error?: string;
}

export interface PeerRuntimeBindingStatus {
  peer: string;
  service: string;
  listen: PeerBinding["listen"];
  kind: "tcp" | "udp";
  port?: number;
  available: boolean;
  error?: string;
}

export interface PeerRuntimeStatus {
  role: "peer";
  state: "running" | "stopped";
  peerKey: string;
  gateway: {
    port: number;
    url: string;
  };
  connections: PeerRuntimeConnectionStatus[];
  services: PeerRuntimeServiceStatus[];
  bindings: PeerRuntimeBindingStatus[];
  metrics?: {
    host: string;
    port: number;
    url: string;
  };
  pairing: PublisherPairingSnapshot;
}

export interface StartPeerOptions {
  stateDir: string;
  config: PeerConfig;
  bootstrap?: DhtAddress[];
  dht?: DhtNode;
  log?: (line: string) => void;
  now?: () => number;
  observe?: Observe;
  sleep?: (delayMs: number) => Promise<void>;
  connectTimeoutMs?: number;
  capabilityTimeoutMs?: number;
  serviceAcquisitionTimeoutMs?: number;
  metricsListen?: MetricsListenAddress;
  /** Persist the complete canonical config before pairing is authorized. */
  persistConfig?: (config: PeerConfig) => Promise<void>;
  pairing?: {
    enabled?: boolean;
    displayName?: string;
  };
}

export interface RunningPeer {
  peerKey: string;
  gateway: Pick<RunningHttpGateway, "port" | "url">;
  applyConfig: (config: PeerConfig) => Promise<boolean>;
  open: (
    peer: string,
    service: string,
    signal?: CancellationSignal,
  ) => Promise<Duplex>;
  status: () => PeerRuntimeStatus;
  createPairingInvitation: () => { uri: string; expiresAt: number };
  pairingStatus: () => PublisherPairingSnapshot;
  approvePairing: () => Promise<void>;
  denyPairing: () => void;
  cancelPairing: () => void;
  pair: (
    invitation: string,
    deviceLabel: string,
    platform: string,
  ) => Promise<PeerRuntimeStatus>;
  stop: () => Promise<void>;
}

interface PeerConnection {
  entry: PeerEntry;
  generation: number;
  outer: DhtStream;
  mux: RunningMuxPeer;
  capability: PeerCapability | "pending";
  catalog?: HomeRegistry;
  catalogTask?: Promise<void>;
  catalogRefreshTimer?: ReturnType<typeof setTimeout>;
  closed: boolean;
  error?: string;
  udpMappings: Map<string, CanonicalUdpMapping>;
}

interface PeerEntry {
  definition: PeerDefinition;
  current?: PeerConnection;
  generation: number;
  reconnectTask?: Promise<void>;
  stopped: boolean;
  error?: string;
  /** Last authenticated catalog, retained to report known services offline. */
  lastCatalog?: HomeRegistry;
  pairingRequest?: PairingRequest;
}

interface CanonicalUdpMapping {
  connection: PeerConnection;
  remote: CanonicalUdpRemote;
  sourceServiceId: string;
  upstreamFlowId: Uint8Array;
  downstreamFlowId: Uint8Array;
  generation: number;
  reassembler: UdpDatagramReassembler;
}

class CanonicalUdpRemote implements UdpPublisherRemote {
  private readonly mappings = new Map<string, CanonicalUdpMapping>();
  private closed = false;

  constructor(
    private readonly runtime: {
      currentConnection: (publicKey: string) => PeerConnection | undefined;
      now: () => number;
      sourcePeerKey: string;
      sourceServiceId: string;
    },
    private readonly onReply: (flowId: Uint8Array, payload: Uint8Array) => void,
  ) {}

  available(): boolean {
    const connection = this.connection();
    const service = connection?.catalog?.services.find(
      ({ id }) => id === this.runtime.sourceServiceId,
    );
    return (
      !this.closed &&
      connection !== undefined &&
      !connection.closed &&
      connection.capability === "ready" &&
      connection.mux.udp.available() &&
      service?.kind === "udp" &&
      service.available !== false
    );
  }

  async send(
    downstreamFlowId: Uint8Array,
    payload: Uint8Array,
    messageId: number,
  ): Promise<UdpSendResult> {
    const connection = this.connection();
    if (!this.available() || !connection) {
      return { ok: false, error: "Upstream UDP carrier is unavailable" };
    }
    const key = flowKey(downstreamFlowId);
    let mapping = this.mappings.get(key);
    if (!mapping || mapping.generation !== connection.generation) {
      if (mapping) this.removeMapping(mapping);
      mapping = {
        connection,
        remote: this,
        sourceServiceId: this.runtime.sourceServiceId,
        upstreamFlowId: b4a.from(crypto.randomBytes(16)),
        downstreamFlowId: b4a.from(downstreamFlowId),
        generation: connection.generation,
        reassembler: new UdpDatagramReassembler({
          now: this.runtime.now,
          onDrop: () => undefined,
        }),
      };
      this.mappings.set(key, mapping);
      connection.udpMappings.set(
        udpMappingKey(mapping.sourceServiceId, mapping.upstreamFlowId),
        mapping,
      );
    }
    let envelopes: Uint8Array[];
    try {
      envelopes = encodeUdpDataEnvelopes({
        serviceId: mapping.sourceServiceId,
        flowId: mapping.upstreamFlowId,
        payload,
        messageId,
      });
    } catch (error) {
      return { ok: false, error: boundedError(errorMessage(error)) };
    }
    try {
      for (const envelope of envelopes) {
        const result = await connection.mux.udp.send(envelope);
        if (!result.ok) {
          this.removeMapping(mapping);
          return {
            ok: false,
            error: result.error ?? "Upstream UDP send failed",
          };
        }
      }
      return { ok: true };
    } catch (error) {
      this.removeMapping(mapping);
      return { ok: false, error: boundedError(errorMessage(error)) };
    }
  }

  closeFlow(downstreamFlowId: Uint8Array): void {
    const mapping = this.mappings.get(flowKey(downstreamFlowId));
    if (!mapping) return;
    this.removeMapping(mapping);
    if (!this.available()) return;
    void mapping.connection.mux.udp.send(
      encodeUdpEnvelope({
        type: "close",
        serviceId: mapping.sourceServiceId,
        flowId: mapping.upstreamFlowId,
        payload: new Uint8Array(),
      }),
    );
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const mapping of [...this.mappings.values()]) this.removeMapping(mapping);
  }

  clear(): void {
    for (const mapping of [...this.mappings.values()]) this.removeMapping(mapping);
  }

  receiveReply(mapping: CanonicalUdpMapping, payload: Uint8Array): void {
    if (
      this.closed ||
      this.mappings.get(flowKey(mapping.downstreamFlowId)) !== mapping
    ) {
      return;
    }
    this.onReply(mapping.downstreamFlowId, payload);
  }

  clearConnection(connection: PeerConnection): void {
    for (const mapping of [...this.mappings.values()]) {
      if (mapping.connection === connection) this.removeMapping(mapping);
    }
  }

  dropMapping(mapping: CanonicalUdpMapping): void {
    this.removeMapping(mapping);
  }

  private connection(): PeerConnection | undefined {
    return this.runtime.currentConnection(this.runtime.sourcePeerKey);
  }

  private removeMapping(mapping: CanonicalUdpMapping): void {
    if (this.mappings.get(flowKey(mapping.downstreamFlowId)) !== mapping) return;
    this.mappings.delete(flowKey(mapping.downstreamFlowId));
    mapping.connection.udpMappings.delete(
      udpMappingKey(mapping.sourceServiceId, mapping.upstreamFlowId),
    );
    mapping.reassembler.clear();
  }
}

interface BindingRuntime {
  binding: PeerBinding;
  kind: "tcp" | "udp";
  server?: Server;
  udp?: RunningPeerUdpBinding;
  port?: number;
  unixOwnership?: {
    path: string;
    dev: number;
    ino: number;
  };
}

export async function startPeer(
  options: StartPeerOptions,
): Promise<RunningPeer> {
  if (options.dht && (options.bootstrap ?? options.config.network?.bootstrap)) {
    throw new Error("peer dht and bootstrap are mutually exclusive");
  }
  const identity = await loadPeerIdentity(options.stateDir);
  const keyPair = keyPairFromSeed(identity.seed);
  const peerKey = b4a.toString(keyPair.publicKey, "hex");
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? delay;
  const route = options.config.network?.route ?? "auto";
  const ownsDht = options.dht === undefined;
  const dht =
    options.dht ??
    createDht({
      bootstrap: options.bootstrap ?? options.config.network?.bootstrap,
      keyPair,
    });

  let activeConfig = options.config;
  const peerEntries = new Map<string, PeerEntry>();
  const services = new Map<string, PeerService>();
  const localSourceErrors = new Map<string, string>();
  const localSourceErrorTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const serviceRateLimiters = new Map<
    string,
    { rateBps: number; limiter: TokenBucketRateLimiter }
  >();
  const bindings = new Map<string, PeerBinding>();
  const homeServers = new Map<string, Promise<import("../home/server.js").RunningHomeServer>>();
  const bindingRuntimes = new Map<string, BindingRuntime>();
  const metricsRecorder: PeerMetricsRecorder = createPeerMetricsRecorder(
    peerMetricsPolicy(activeConfig),
    now,
  );
  let gateway: RunningHttpGateway;
  let metricsServer: RunningMetricsServer | undefined;
  let server: ReturnType<DhtNode["createServer"]>;
  let stopped = false;
  let gatewayStopping: Promise<void> | undefined;
  let stopTask: Promise<void> | undefined;
  let configTask: Promise<void> = Promise.resolve();
  const pairingCandidates = new Set<string>();
  const canonicalUdpRemotes = new Set<CanonicalUdpRemote>();
  const pendingPeerPairings = new Map<
    string,
    { resolve: () => void; reject: (error: Error) => void }
  >();
  let pendingPairingAdmissions = 0;
  let cancelPairingExpiry: (() => void) | undefined;

  const pairing = new PublisherPairing({
    publisherKey: peerKey,
    displayName: options.pairing?.displayName ?? "Kepos peer",
    now,
    persistPeer: async (device) => {
      const existing = activeConfig.peers.find(
        ({ publicKey }) => publicKey === device.publicKey,
      );
      if (existing) return;
      const nextConfig = {
        ...activeConfig,
        peers: [
          ...activeConfig.peers,
          {
            label: device.label,
            publicKey: device.publicKey,
            connection: "accept" as const,
          },
        ],
      };
      if (!options.persistConfig) {
        throw new Error("peer pairing config persistence is unavailable");
      }
      await options.persistConfig(nextConfig);
      await applyConfig(nextConfig);
      pairingCandidates.delete(device.publicKey);
      const entry = peerEntries.get(device.publicKey);
      entry?.current?.mux.authorize();
      if (entry?.current?.capability === "ready") {
        void refreshCatalog(entry.current);
      }
    },
  });

  validateRuntimeConfig(activeConfig, peerKey);
  installConfig(activeConfig);

  server = dht.createServer(
    {
      firewall: (remotePublicKey) => {
        const remoteKey = b4a.toString(remotePublicKey, "hex");
        const entry = peerEntries.get(remoteKey);
        const candidate =
          options.pairing?.enabled !== false &&
          entry === undefined &&
          pairing.acceptsCandidates() &&
          pendingPairingAdmissions < 1;
        if (candidate) pendingPairingAdmissions++;
        const rejected =
          !candidate &&
          (entry === undefined || entry.definition.connection !== "accept");
        if (rejected) {
          createObservationEmitter({
            observe: options.observe,
            role: "peer",
            outerId: createObservationId("outer"),
            now,
            route,
          })("outer.rejected", { remotePublicKey });
        }
        return rejected;
      },
      reusableSocket: true,
    },
    (stream) => {
      const remoteKey = b4a.toString(stream.remotePublicKey, "hex");
      const entry = peerEntries.get(remoteKey);
      if (!entry || entry.definition.connection !== "accept") {
        if (entry === undefined && pendingPairingAdmissions > 0) {
          pendingPairingAdmissions--;
        }
        if (
          entry === undefined &&
          options.pairing?.enabled !== false &&
          pairing.acceptsCandidates()
        ) {
          const candidate: PeerEntry = {
            definition: {
              label: `pairing-${remoteKey.slice(0, 8)}`,
              publicKey: remoteKey,
              connection: "accept",
            },
            generation: 0,
            stopped: false,
          };
          peerEntries.set(remoteKey, candidate);
          pairingCandidates.add(remoteKey);
          void installConnection(candidate, stream, "accepted", undefined, false, {
            onPairingRequest: (request, decision) => {
              const received = pairing.receive({
                subscriberKey: remoteKey,
                request,
                approve: decision.approve,
                deny: decision.deny,
                fail: decision.fail,
              });
              if (received) options.log?.(`Pairing request from ${remoteKey}`);
            },
          }).catch((error: unknown) => {
            candidate.error = errorMessage(error);
            stream.destroy(error instanceof Error ? error : new Error(String(error)));
          });
          return;
        }
        stream.destroy(new Error("Peer is not configured to accept connections"));
        return;
      }
      void installConnection(entry, stream, "accepted").catch((error: unknown) => {
        entry.error = errorMessage(error);
        stream.destroy(error instanceof Error ? error : new Error(String(error)));
      });
    },
  );

  try {
    await server.listen(keyPair);
    const metricsListen = metricsListenFor(activeConfig);
    if (metricsListen) {
      metricsServer = await startMetricsServer({
        listen: metricsListen,
        render: () => metricsRecorder.render(),
      });
    }
    gateway = await startHttpGateway({
      port: activeConfig.gateway?.port ?? DEFAULT_GATEWAY_PORT,
      host: activeConfig.gateway?.host,
      domain: activeConfig.gateway?.domain,
      acquisitionTimeoutMs:
        options.serviceAcquisitionTimeoutMs ?? defaultServiceAcquisitionTimeoutMs,
      open: openGatewayService,
    });
    await rebuildBindings();
  } catch (error) {
    await cleanupStarted().catch(() => undefined);
    throw error;
  }

  for (const entry of peerEntries.values()) {
    if (entry.definition.connection === "dial") {
      startDialing(entry);
    }
  }

  function createPairingInvitation(): { uri: string; expiresAt: number } {
    if (options.pairing?.enabled === false) {
      throw new Error("peer pairing is disabled");
    }
    cancelPairingExpiry?.();
    const invitation = pairing.createInvitation();
    const timer = setTimeout(() => {
      if (pairing.snapshot().phase !== "inviting") return;
      closePairingCandidates();
      cancelPairingExpiry = undefined;
    }, Math.max(0, invitation.expiresAt - now()));
    timer.unref?.();
    cancelPairingExpiry = () => clearTimeout(timer);
    return invitation;
  }

  function closePairingCandidates(): void {
    for (const publicKey of pairingCandidates) {
      const entry = peerEntries.get(publicKey);
      if (!entry) continue;
      entry.stopped = true;
      entry.current?.mux.close();
      if (!activeConfig.peers.some((peer) => peer.publicKey === publicKey)) {
        peerEntries.delete(publicKey);
      }
    }
    pairingCandidates.clear();
    pendingPairingAdmissions = 0;
  }

  function cancelPairing(): void {
    cancelPairingExpiry?.();
    cancelPairingExpiry = undefined;
    pairing.cancel();
    closePairingCandidates();
  }

  async function pairPeer(
    invitationUri: string,
    deviceLabel: string,
    platform: string,
  ): Promise<PeerRuntimeStatus> {
    if (stopped) throw new Error("Peer runtime is stopped");
    const invitation = parsePairingInvitation(invitationUri, { now });
    if (
      deviceLabel.length === 0 ||
      deviceLabel.trim() !== deviceLabel ||
      b4a.byteLength(deviceLabel, "utf8") > 128 ||
      /[\u0000-\u001f\u007f]/u.test(deviceLabel) ||
      !/^[a-z0-9][a-z0-9_-]{0,31}$/u.test(platform)
    ) {
      throw new Error("pairing device details are invalid");
    }
    if (activeConfig.peers.some(({ publicKey }) => publicKey === invitation.publisherKey)) {
      throw new Error("peer is already configured");
    }
    if (pendingPeerPairings.has(invitation.publisherKey)) {
      throw new Error("peer pairing is already in progress");
    }
    const entry: PeerEntry = {
      definition: {
        label: invitation.displayName,
        publicKey: invitation.publisherKey,
        connection: "dial",
      },
      generation: 0,
      stopped: false,
      pairingRequest: {
        token: invitation.token,
        label: deviceLabel,
        platform,
      },
    };
    peerEntries.set(invitation.publisherKey, entry);
    const approved = new Promise<void>((resolve, reject) => {
      pendingPeerPairings.set(invitation.publisherKey, {
        resolve,
        reject: (error) => reject(error),
      });
    });
    const expiry = setTimeout(() => {
      pendingPeerPairings.get(invitation.publisherKey)?.reject(
        new Error("Pairing invitation has expired"),
      );
      entry.current?.mux.close();
    }, Math.max(0, invitation.expiresAt - now()));
    expiry.unref?.();
    try {
      startDialing(entry);
      await approved;
      return runtimeStatus();
    } finally {
      clearTimeout(expiry);
      pendingPeerPairings.delete(invitation.publisherKey);
      if (!activeConfig.peers.some(({ publicKey }) => publicKey === invitation.publisherKey)) {
        entry.stopped = true;
        entry.current?.mux.close();
        if (peerEntries.get(invitation.publisherKey) === entry) {
          peerEntries.delete(invitation.publisherKey);
        }
      }
    }
  }

  options.log?.(`Peer ready: ${peerKey}`);
  return {
    peerKey,
    gateway,
    applyConfig: (nextConfig) => applyConfig(nextConfig),
    open: openPeerService,
    status: () => runtimeStatus(),
    createPairingInvitation,
    pairingStatus: () => pairing.snapshot(),
    approvePairing: () => pairing.approve(),
    denyPairing: cancelPairing,
    cancelPairing,
    pair: pairPeer,
    stop: () => stop(),
  };

  function installConfig(config: PeerConfig): void {
    services.clear();
    for (const service of config.services) services.set(service.id, service);
    bindings.clear();
    for (const binding of config.bindings) {
      bindings.set(bindingKey(binding, resolvePeerKey), binding);
    }
    const desired = new Map<string, PeerDefinition>();
    for (const definition of config.peers) desired.set(definition.publicKey, definition);
    for (const [publicKey, entry] of peerEntries) {
      const definition = desired.get(publicKey);
      if (!definition) {
        entry.stopped = true;
        entry.current?.mux.close();
        peerEntries.delete(publicKey);
        continue;
      }
      if (entry.definition.connection !== definition.connection) {
        // A changed direction belongs to the same authenticated key, but the
        // old connection must not survive the policy replacement. A label-only
        // change does not affect the authenticated channel.
        entry.current?.mux.close();
        entry.current = undefined;
        entry.error = undefined;
        entry.lastCatalog = undefined;
      }
      entry.definition = definition;
      entry.stopped = false;
    }
    for (const definition of config.peers) {
      if (definition.publicKey === peerKey) continue;
      if (!peerEntries.has(definition.publicKey)) {
        peerEntries.set(definition.publicKey, {
          definition,
          generation: 0,
          stopped: false,
        });
      }
    }
  }

  async function applyConfig(nextConfig: PeerConfig): Promise<boolean> {
    const result = configTask.then(async () => {
      validateRuntimeConfig(nextConfig, peerKey);
      if (JSON.stringify(activeConfig) === JSON.stringify(nextConfig)) return false;
      const previous = activeConfig;
      for (const remote of canonicalUdpRemotes) remote.clear();
      for (const timer of localSourceErrorTimers.values()) clearTimeout(timer);
      localSourceErrorTimers.clear();
      localSourceErrors.clear();
      activeConfig = nextConfig;
      installConfig(nextConfig);
      metricsRecorder.applyPolicy(peerMetricsPolicy(nextConfig));
      for (const [serviceId, current] of serviceRateLimiters) {
        const nextRateBps = services.get(serviceId)?.maxPublisherToSubscriberBps;
        if (nextRateBps !== current.rateBps) serviceRateLimiters.delete(serviceId);
      }
      for (const entry of peerEntries.values()) {
        entry.current?.mux.closeServiceChannels();
        entry.current?.mux.closeUdpFlows();
        if (entry.definition.connection === "dial") startDialing(entry);
      }
      for (const [key, runtime] of bindingRuntimes) {
        const nextBinding = bindings.get(key);
        if (
          !nextBinding ||
          JSON.stringify(nextBinding) !== JSON.stringify(runtime.binding)
        ) {
          await closeBinding(runtime);
          bindingRuntimes.delete(key);
        }
      }
      for (const binding of bindings.values()) {
        if (!bindingRuntimes.has(bindingKey(binding, resolvePeerKey))) {
          await startBinding(binding);
        }
      }
      updateHomeServers();
      if (
        JSON.stringify(previous.gateway) !== JSON.stringify(nextConfig.gateway)
      ) {
        await restartGateway();
      }
      if (
        JSON.stringify(previous.metrics) !== JSON.stringify(nextConfig.metrics) &&
        options.metricsListen === undefined
      ) {
        await restartMetrics();
      }
      updateUdpBindings();
      return true;
    });
    configTask = result.then(() => undefined, () => undefined);
    return result;
  }

  function validateRuntimeConfig(config: PeerConfig, ownKey: string): void {
    const knownPeers = new Set(config.peers.map(({ publicKey }) => publicKey));
    if (knownPeers.has(ownKey)) {
      throw new Error("peer config must not list the local peer as a remote peer");
    }
    for (const service of config.services) {
      for (const grantedKey of service.allow) {
        if (!knownPeers.has(grantedKey)) {
          throw new Error(`service ${service.id} grants an unknown peer: ${grantedKey}`);
        }
      }
      if ("peer" in service.source && !knownPeers.has(resolveConfiguredPeerKey(config.peers, service.source.peer))) {
        throw new Error(`service ${service.id} references an unknown upstream peer`);
      }
    }
    for (const binding of config.bindings) {
      resolveConfiguredPeerKey(config.peers, binding.peer);
    }
  }

  function startDialing(entry: PeerEntry): void {
    if (stopped || entry.stopped || entry.reconnectTask) return;
    entry.reconnectTask = dialLoop(entry).finally(() => {
      entry.reconnectTask = undefined;
    });
  }

  async function dialLoop(entry: PeerEntry): Promise<void> {
    let delayMs = minimumReconnectDelayMs;
    while (
      !stopped &&
      !entry.stopped &&
      entry.definition.connection === "dial"
    ) {
      if (entry.current) {
        await onceClosed(entry.current.outer);
        delayMs = minimumReconnectDelayMs;
        continue;
      }
      let outer: DhtStream | undefined;
      try {
        const outerObserve = createObservationEmitter({
          observe: options.observe,
          role: "peer",
          outerId: createObservationId("outer"),
          now,
          route,
        });
        outerObserve("outer.attempt", { publicKey: entry.definition.publicKey });
        outer = dht.connect(Buffer.from(entry.definition.publicKey, "hex"), {
          keyPair,
          ...connectionOptionsForRoute(route),
          holepunch: (
            remoteFirewall,
            localFirewall,
            remoteAddresses,
            localAddresses,
          ) => {
            outerObserve(
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
        });
        await waitForConnect(
          outer,
          options.connectTimeoutMs ?? defaultConnectTimeoutMs,
        );
        if (
          stopped ||
          entry.stopped ||
          entry.definition.connection !== "dial"
        ) {
          outer.destroy();
          return;
        }
        outer.setKeepAlive?.(10_000);
        outerObserve("outer.handshake", {
          transport: dhtStreamSnapshot(outer),
        });
        outerObserve("outer.connected", {
          transport: dhtStreamSnapshot(outer),
          dht: dhtStatsSnapshot(dht),
        });
        await installConnection(entry, outer, "dialed", outerObserve);
        delayMs = minimumReconnectDelayMs;
        await onceClosed(outer);
      } catch (error) {
        const message = errorMessage(error);
        entry.error = message;
        if (outer && !outer.destroyed) outer.destroy(new Error(message));
        if (stopped || entry.stopped) return;
        options.log?.(`Peer connection to ${entry.definition.label} failed: ${message}`);
        await sleep(delayMs);
        delayMs = Math.min(delayMs * 2, maximumReconnectDelayMs);
      }
    }
  }

  async function installConnection(
    entry: PeerEntry,
    outer: DhtStream,
    mode: "accepted" | "dialed",
    existingObserve?: ReturnType<typeof createObservationEmitter>,
    authorized = true,
    peerOptions: Pick<
      MuxPeerOptions,
      | "onPairingRequest"
      | "pairingRequest"
      | "onPairingPending"
      | "onPairingApproved"
      | "onPairingFailed"
    > = {},
  ): Promise<void> {
    const generation = ++entry.generation;
    const outerId = existingObserve ? undefined : createObservationId("outer");
    const observe =
      existingObserve ??
      createObservationEmitter({
        observe: options.observe,
        role: "peer",
        outerId,
        now,
        route,
      });
    const connection: PeerConnection = {
      entry,
      generation,
      outer,
      mux: undefined as unknown as RunningMuxPeer,
      capability: "pending",
      closed: false,
      udpMappings: new Map(),
    };
    const previous = entry.current;
    entry.current = connection;
    entry.error = undefined;
    previous?.mux.close();
    observe(mode === "accepted" ? "outer.accepted" : "outer.connected", {
      remotePublicKey: outer.remotePublicKey,
      transport: dhtStreamSnapshot(outer),
    });
    const metricsContext = {
      subscriberKey: entry.definition.publicKey,
      connectionId: `${entry.definition.publicKey}:${generation}`,
    };
    let mux: RunningMuxPeer;
    try {
      const pairingRequest = entry.pairingRequest;
      mux = createMuxPeer(outer, {
        authorized: pairingRequest === undefined && authorized,
        accept: (serviceId) => acceptService(connection, serviceId),
        capabilityTimeoutMs: options.capabilityTimeoutMs,
        heartbeat: {},
        now,
        observationRole: "peer",
        observe: options.observe,
        outerId: outerId ?? createObservationId("outer"),
        remotePublicKey: entry.definition.publicKey,
        httpRemotePublicKey: entry.definition.publicKey,
        serviceAuthorized: (serviceId) =>
          serviceAllowed(serviceId, entry.definition.publicKey),
        serviceKind: (serviceId) => services.get(serviceId)?.kind ?? "tcp",
        serviceTargetPort: (serviceId) => {
          const service = services.get(serviceId);
          return service && service.kind === "udp" && "localPort" in service.source
            ? service.source.localPort
            : undefined;
        },
        udpRemote: (serviceId, onReply) => {
          const service = services.get(serviceId);
          if (
            !service ||
            service.kind !== "udp" ||
            !("peer" in service.source)
          ) {
            return undefined;
          }
          const upstreamKey = resolvePeerKey(service.source.peer);
          if (upstreamKey === entry.definition.publicKey) return undefined;
          const remote = new CanonicalUdpRemote(
            {
              currentConnection: (publicKey) =>
                peerEntries.get(publicKey)?.current,
              now,
              sourcePeerKey: upstreamKey,
              sourceServiceId: service.source.service,
            },
            onReply,
          );
          canonicalUdpRemotes.add(remote);
          return remote;
        },
        udpIgnoreIncoming: (envelope) =>
          connection.udpMappings.has(
            udpMappingKey(envelope.serviceId, envelope.flowId),
          ),
        transportSnapshot: () => dhtStreamSnapshot(outer),
        publisherToSubscriberRateLimiter,
        metrics: metricsRecorder,
        metricsContext,
        ...(pairingRequest
          ? {
              pairingRequest,
              onPairingPending: () => {
                options.log?.(`Pairing request pending for ${entry.definition.label}`);
                peerOptions.onPairingPending?.();
              },
              onPairingApproved: async () => {
                if (!options.persistConfig) {
                  throw new Error("peer pairing config persistence is unavailable");
                }
                const nextConfig: PeerConfig = {
                  ...activeConfig,
                  peers: [...activeConfig.peers, entry.definition],
                };
                await options.persistConfig(nextConfig);
                entry.pairingRequest = undefined;
                await applyConfig(nextConfig);
                pendingPeerPairings.get(entry.definition.publicKey)?.resolve();
                await peerOptions.onPairingApproved?.();
              },
              onPairingFailed: (error: Error) => {
                pendingPeerPairings.get(entry.definition.publicKey)?.reject(error);
                peerOptions.onPairingFailed?.(error);
              },
            }
          : {}),
        ...peerOptions,
      });
    } catch (error) {
      connection.closed = true;
      if (entry.current === connection) entry.current = undefined;
      if (!outer.destroyed) {
        outer.destroy(error instanceof Error ? error : new Error(String(error)));
      }
      throw error;
    }
    connection.mux = mux;
    metricsRecorder.connectionActivated(metricsContext);
    mux.udp.onMessage((message) => {
      receiveCanonicalUdp(connection, message);
    });
    mux.udp.onReset(() => {
      clearCanonicalUdpMappings(connection);
    });
    void mux.capability.then((capability) => {
      if (entry.current !== connection) return;
      connection.capability = capability;
      if (capability === "ready") {
        void refreshCatalog(connection);
        scheduleCatalogRefresh(connection);
      }
      updateUdpBindings();
    });
    let streamError: string | undefined;
    outer.once("error", (error) => {
      streamError = error.message;
    });
    outer.once("close", () => {
      connection.closed = true;
      if (connection.catalogRefreshTimer) {
        clearTimeout(connection.catalogRefreshTimer);
        connection.catalogRefreshTimer = undefined;
      }
      clearCanonicalUdpMappings(connection);
      for (const remote of canonicalUdpRemotes) remote.clearConnection(connection);
      metricsRecorder.connectionClosed(metricsContext);
      updateUdpBindings();
      if (entry.current !== connection) return;
      entry.current = undefined;
      entry.error = streamError;
      connection.catalog = undefined;
      updateHomeServers();
      observe("outer.closed", {
        trigger: stopped ? "local.stop" : "stream.close",
        ...(streamError ? { error: streamError } : {}),
      });
      if (
        pairingCandidates.has(entry.definition.publicKey) &&
        !activeConfig.peers.some(
          (peer) => peer.publicKey === entry.definition.publicKey,
        )
      ) {
        pairingCandidates.delete(entry.definition.publicKey);
        peerEntries.delete(entry.definition.publicKey);
      }
      if (
        entry.pairingRequest !== undefined &&
        !activeConfig.peers.some(
          (peer) => peer.publicKey === entry.definition.publicKey,
        )
      ) {
        pendingPeerPairings.get(entry.definition.publicKey)?.reject(
          new Error("Peer pairing connection closed"),
        );
        pendingPeerPairings.delete(entry.definition.publicKey);
        entry.stopped = true;
        peerEntries.delete(entry.definition.publicKey);
      }
      if (!stopped && !entry.stopped && entry.definition.connection === "dial") {
        startDialing(entry);
      }
    });
    // A newly accepted stream can be used immediately; the capability promise
    // is only required by opens in the reverse direction.
    updateHomeServers();
  }

  async function refreshCatalog(connection: PeerConnection): Promise<void> {
    if (connection.catalogTask) return connection.catalogTask;
    connection.catalogTask = (async () => {
      try {
        const home = await connection.mux.open("home");
        const registry = await readHomeRegistryFromConnection(home);
        home.destroy();
        if (registry.publisher.publisherKey !== connection.entry.definition.publicKey) {
          throw new Error("Home registry identity does not match authenticated peer");
        }
        if (connection.entry.current !== connection) return;
        connection.catalog = registry;
        connection.entry.lastCatalog = registry;
        connection.error = undefined;
        updateUdpBindings();
        updateHomeServers();
      } catch (error) {
        connection.error = errorMessage(error);
        connection.catalog = undefined;
        updateUdpBindings();
        updateHomeServers();
      } finally {
        connection.catalogTask = undefined;
      }
    })();
    return connection.catalogTask;
  }

  function scheduleCatalogRefresh(connection: PeerConnection): void {
    if (
      stopped ||
      connection.closed ||
      connection.entry.current !== connection ||
      connection.capability !== "ready" ||
      connection.catalogRefreshTimer
    ) {
      return;
    }
    const timer = setTimeout(() => {
      connection.catalogRefreshTimer = undefined;
      if (
        stopped ||
        connection.closed ||
        connection.entry.current !== connection ||
        connection.capability !== "ready"
      ) {
        return;
      }
      void refreshCatalog(connection).finally(() => {
        scheduleCatalogRefresh(connection);
      });
    }, catalogRefreshIntervalMs);
    timer.unref?.();
    connection.catalogRefreshTimer = timer;
  }

  async function acceptService(
    connection: PeerConnection,
    serviceId: string,
  ): Promise<Duplex> {
    if (connection.entry.current !== connection) {
      throw new Error("Peer connection is not current");
    }
    if (serviceId === "home") {
      const home = await homeServerFor(connection.entry);
      return connectLoopback(home.port);
    }
    const service = services.get(serviceId);
    if (!service) throw new Error(`Service is not published: ${serviceId}`);
    if (!serviceAllowed(serviceId, connection.entry.definition.publicKey)) {
      throw new Error(`Service is not authorized: ${serviceId}`);
    }
    if (service.kind === "udp") {
      throw new Error("UDP service requires its established datagram operation");
    }
    if ("localPort" in service.source) {
      try {
        const socket = await connectLoopback(service.source.localPort);
        clearLocalSourceError(service.id);
        return socket;
      } catch (error) {
        recordLocalSourceError(service.id, errorMessage(error));
        updateHomeServers();
        throw error;
      }
    }
    if ("unixSocket" in service.source) {
      try {
        const socket = await connectUnixSocket(service.source.unixSocket);
        clearLocalSourceError(service.id);
        return socket;
      } catch (error) {
        recordLocalSourceError(service.id, errorMessage(error));
        updateHomeServers();
        throw error;
      }
    }
    const upstreamKey = resolvePeerKey(service.source.peer);
    if (upstreamKey === connection.entry.definition.publicKey) {
      throw new Error("Upstream source cannot use the requesting peer");
    }
    return openPeerService(upstreamKey, service.source.service, undefined, service.kind);
  }

  function serviceAllowed(serviceId: string, remoteKey: string): boolean {
    if (serviceId === "home") return true;
    const service = services.get(serviceId);
    return service !== undefined && service.allow.includes(remoteKey);
  }

  function recordLocalSourceError(serviceId: string, message: string): void {
    localSourceErrors.set(serviceId, message);
    const existing = localSourceErrorTimers.get(serviceId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      localSourceErrorTimers.delete(serviceId);
      localSourceErrors.delete(serviceId);
      updateHomeServers();
    }, 1_000);
    timer.unref?.();
    localSourceErrorTimers.set(serviceId, timer);
  }

  function clearLocalSourceError(serviceId: string): void {
    localSourceErrors.delete(serviceId);
    const timer = localSourceErrorTimers.get(serviceId);
    if (timer) clearTimeout(timer);
    localSourceErrorTimers.delete(serviceId);
  }

  function publisherToSubscriberRateLimiter(
    serviceId: string,
  ): TokenBucketRateLimiter | undefined {
    const rateBps = services.get(serviceId)?.maxPublisherToSubscriberBps;
    if (rateBps === undefined) {
      serviceRateLimiters.delete(serviceId);
      return undefined;
    }
    const current = serviceRateLimiters.get(serviceId);
    if (current?.rateBps === rateBps) return current.limiter;
    const limiter = new TokenBucketRateLimiter({ rateBps, now });
    serviceRateLimiters.set(serviceId, { rateBps, limiter });
    return limiter;
  }

  async function openPeerService(
    peerReference: string,
    serviceId: string,
    signal?: CancellationSignal,
    expectedKind?: PeerService["kind"],
    acquisition: { currentOnly?: boolean } = {},
  ): Promise<Duplex> {
    const entry = peerEntries.get(resolvePeerKey(peerReference));
    if (!entry) throw new Error(`Peer is not configured: ${peerReference}`);
    const initialConnection = entry.current;
    const initialGeneration = initialConnection?.generation;
    if (acquisition.currentOnly && initialGeneration === undefined) {
      throw new Error(`Peer is offline: ${entry.definition.label}`);
    }
    const timeoutMs =
      options.serviceAcquisitionTimeoutMs ?? defaultServiceAcquisitionTimeoutMs;
    const deadline = now() + timeoutMs;
    while (!stopped) {
      throwIfAborted(signal);
      const connection = entry.current;
      if (
        acquisition.currentOnly &&
        (!connection || connection.generation !== initialGeneration)
      ) {
        throw new Error("Peer connection changed before service acquisition");
      }
      if (connection && !connection.closed) {
        if (connection.capability === "pending") {
          const capability = await waitWithAbort(
            connection.mux.capability,
            signal,
            deadline,
            now,
          );
          connection.capability = capability;
        }
        if (connection.capability !== "ready") {
          throw new Error("Peer does not support reverse byte-stream services");
        }
        if (serviceId !== "home") {
          await waitForCatalog(connection, signal, deadline);
          const remoteService = connection.catalog?.services.find(
            ({ id }) => id === serviceId,
          );
          if (!remoteService) {
            throw new Error(`Service is unauthorized or unavailable: ${serviceId}`);
          }
          if (remoteService.available === false) {
            throw new Error(
              remoteService.error ?? `Service is unavailable: ${serviceId}`,
            );
          }
          if (expectedKind === "udp" || remoteService.kind === "udp") {
            throw new Error("Reverse UDP service channels are unsupported");
          }
          if (expectedKind === "http" && remoteService.kind !== "tcp") {
            throw new Error("Remote service transport kind is incompatible");
          }
        }
        try {
          return await connection.mux.open(serviceId);
        } catch (error) {
          if (entry.current === connection && !connection.closed) throw error;
        }
      }
      if (now() >= deadline) {
        throw new Error(
          entry.error
            ? `Peer is unavailable: ${entry.error}`
            : `Peer is offline: ${entry.definition.label}`,
        );
      }
      if (acquisition.currentOnly) {
        throw new Error("Peer connection is unavailable");
      }
      await waitWithAbort(sleep(25), signal, deadline, now);
    }
    throw new Error("Peer runtime is stopped");
  }

  async function waitForCatalog(
    connection: PeerConnection,
    signal: CancellationSignal | undefined,
    deadline: number,
  ): Promise<void> {
    if (connection.capability !== "ready") return;
    await refreshCatalog(connection);
    if (connection.catalog) return;
    while (connection.entry.current === connection && !connection.catalog) {
      throwIfAborted(signal);
      if (connection.error) {
        throw new Error(`Peer service catalog unavailable: ${connection.error}`);
      }
      if (now() >= deadline) {
        throw new Error("Peer service catalog is unavailable");
      }
      await waitWithAbort(sleep(25), signal, deadline, now);
    }
  }

  async function openGatewayService(
    serviceId: string,
    signal?: CancellationSignal,
  ): Promise<Duplex> {
    const candidates = [...peerEntries.values()].filter((entry) => {
      const service = entry.current?.catalog?.services.find(
        ({ id }) => id === serviceId,
      );
      return service !== undefined && service.kind === "tcp" && service.available !== false;
    });
    const explicit = [...bindings.values()].filter(({ service }) => service === serviceId);
    let selected: PeerEntry | undefined;
    if (candidates.length === 1) {
      selected = candidates[0];
    } else if (candidates.length > 1) {
      if (explicit.length === 1) selected = peerEntries.get(resolvePeerKey(explicit[0]!.peer));
      if (!selected) {
        throw new Error(
          `Service is ambiguous: ${serviceId}; configure one explicit binding`,
        );
      }
    }
    if (!selected) {
      if (serviceId === "home" && peerEntries.size === 1) {
        selected = [...peerEntries.values()][0];
      } else {
        // Let the normal acquisition path wait for a dialing peer and produce
        // the stable offline/unsupported error category.
        const configured = explicit.length === 1
          ? peerEntries.get(resolvePeerKey(explicit[0]!.peer))
          : undefined;
        if (!configured) {
          throw new Error(`Service is offline or unauthorized: ${serviceId}`);
        }
        selected = configured;
      }
    }
    return openPeerService(selected.definition.publicKey, serviceId, signal);
  }

  async function homeServerFor(
    entry: PeerEntry,
  ): Promise<import("../home/server.js").RunningHomeServer> {
    const current = homeServers.get(entry.definition.publicKey);
    if (current) return current;
    const starting = import("../home/server.js").then(({ startHomeServer }) =>
      startHomeServer({
        publisherKey: peerKey,
        displayName: "Kepos peer",
        services: registryServicesFor(entry),
      }),
    );
    homeServers.set(entry.definition.publicKey, starting);
    void starting.catch(() => {
      if (homeServers.get(entry.definition.publicKey) === starting) {
        homeServers.delete(entry.definition.publicKey);
      }
    });
    return starting;
  }

  function registryServicesFor(entry: PeerEntry): HomeRegistry["services"] {
    return [...services.values()]
      .filter((service) => serviceAllowed(service.id, entry.definition.publicKey))
      .map((service) => {
        const status = serviceStatusFor(service);
        return {
          id: service.id,
          name: service.name,
          kind: service.kind === "udp" ? "udp" : "tcp",
          ...(service.kind === "http" ? { access: "http" as const } : {}),
          ...(status.available
            ? {}
            : { available: false, ...(status.error ? { error: status.error } : {}) }),
        };
      });
  }

  function updateHomeServers(): void {
    for (const [publicKey, starting] of homeServers) {
      void starting.then((home) => {
        const entry = peerEntries.get(publicKey);
        if (!entry) return;
        home.updateRegistry({ services: registryServicesFor(entry), displayName: "Kepos peer" });
      }).catch(() => undefined);
    }
  }

  async function rebuildBindings(): Promise<void> {
    for (const runtime of bindingRuntimes.values()) await closeBinding(runtime);
    bindingRuntimes.clear();
    for (const binding of bindings.values()) await startBinding(binding);
  }

  async function startBinding(binding: PeerBinding): Promise<void> {
    const kind = peerBindingKind(binding);
    if ("unixSocket" in binding.listen && process.platform === "win32") {
      throw new Error("Unix socket bindings are unsupported on Windows");
    }
    if (kind === "udp") {
      if (!("localPort" in binding.listen)) {
        throw new Error("UDP bindings require a localPort endpoint");
      }
      const bindingKeyValue = bindingKey(binding, resolvePeerKey);
      if (bindingRuntimes.has(bindingKeyValue)) return;
      const udp = await listenPeerUdpBinding(binding.service, binding.listen.localPort, {
        onError: (message) => options.log?.(`UDP binding ${binding.service}: ${message}`),
      });
      bindingRuntimes.set(bindingKeyValue, {
        binding,
        kind,
        udp,
        port: udp.port,
      });
      updateUdpBindings();
      return;
    }
    const bindingKeyValue = bindingKey(binding, resolvePeerKey);
    if (bindingRuntimes.has(bindingKeyValue)) return;
    const unixPath = "unixSocket" in binding.listen ? binding.listen.unixSocket : undefined;
    if (unixPath !== undefined) {
      if (await pathExists(unixPath)) {
        throw new Error(`Unix binding path is already occupied: ${unixPath}`);
      }
    }
    const listener = createServer({ allowHalfOpen: true }, (socket) => {
      socket.pause();
      void openBindingSocket(socket, binding);
    });
    let unixOwnership: BindingRuntime["unixOwnership"];
    try {
      await listenBinding(listener, binding.listen);
      const address = listener.address();
      const port = address && typeof address !== "string" ? address.port : undefined;
      if (unixPath !== undefined) {
        const stat = await lstat(unixPath);
        if (!stat.isSocket()) {
          throw new Error(`Unix binding did not create a socket: ${unixPath}`);
        }
        unixOwnership = { path: unixPath, dev: stat.dev, ino: stat.ino };
      }
      bindingRuntimes.set(bindingKeyValue, {
        binding,
        kind,
        server: listener,
        ...(port === undefined ? {} : { port }),
        ...(unixOwnership ? { unixOwnership } : {}),
      });
    } catch (error) {
      await closeServer(listener).catch(() => undefined);
      // A failed listen never proves ownership.  In particular, an occupied
      // path may belong to another process; never unlink it as rollback.
      if (unixOwnership) {
        await unlinkOwnedSocket(unixOwnership.path, unixOwnership).catch(
          () => undefined,
        );
      }
      throw error;
    }
  }

  async function openBindingSocket(socket: Socket, binding: PeerBinding): Promise<void> {
    const abort = new CancellationController();
    const timeout = setTimeout(() => {
      abort.abort();
      socket.destroy();
    }, options.serviceAcquisitionTimeoutMs ?? defaultServiceAcquisitionTimeoutMs);
    socket.once("close", () => abort.abort());
    try {
      const tunnel = await openPeerService(
        binding.peer,
        binding.service,
        abort.signal,
        undefined,
        { currentOnly: true },
      );
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

  async function closeBinding(runtime: BindingRuntime): Promise<void> {
    await runtime.udp?.close().catch(() => undefined);
    if (runtime.server) await closeServer(runtime.server).catch(() => undefined);
    if (runtime.unixOwnership) {
      await unlinkOwnedSocket(runtime.unixOwnership.path, runtime.unixOwnership).catch(() => undefined);
    }
  }

  function updateUdpBindings(): void {
    for (const runtime of bindingRuntimes.values()) {
      if (runtime.kind !== "udp" || !runtime.udp) continue;
      let entry: PeerEntry | undefined;
      try {
        entry = peerEntries.get(resolvePeerKey(runtime.binding.peer));
      } catch {
        runtime.udp.setConnection(undefined);
        continue;
      }
      const connection = entry?.current;
      const remote = connection?.catalog?.services.find(
        ({ id }) => id === runtime.binding.service,
      );
      const usable = Boolean(
        connection &&
          !connection.closed &&
          connection.capability === "ready" &&
          connection.mux.udp.available() &&
          remote?.kind === "udp" &&
          remote.available !== false,
      );
      runtime.udp.setConnection(
        usable ? connection!.mux.udp : undefined,
        connection?.generation ?? entry?.generation ?? 0,
      );
    }
  }

  async function restartGateway(): Promise<void> {
    gatewayStopping = (async () => {
      await closeServer(gateway.server);
      gateway = await startHttpGateway({
        port: activeConfig.gateway?.port ?? DEFAULT_GATEWAY_PORT,
        host: activeConfig.gateway?.host,
        domain: activeConfig.gateway?.domain,
        acquisitionTimeoutMs:
          options.serviceAcquisitionTimeoutMs ?? defaultServiceAcquisitionTimeoutMs,
        open: openGatewayService,
      });
    })();
    await gatewayStopping;
    gatewayStopping = undefined;
  }

  function metricsListenFor(config: PeerConfig): MetricsListenAddress | undefined {
    if (options.metricsListen) return { ...options.metricsListen };
    if (!config.metrics) return undefined;
    return {
      host: config.metrics.host ?? "127.0.0.1",
      port: config.metrics.port,
    };
  }

  async function restartMetrics(): Promise<void> {
    await metricsServer?.close().catch(() => undefined);
    metricsServer = undefined;
    const listen = metricsListenFor(activeConfig);
    if (listen) {
      metricsServer = await startMetricsServer({
        listen,
        render: () => metricsRecorder.render(),
      });
    }
  }

  function receiveCanonicalUdp(
    connection: PeerConnection,
    message: Uint8Array,
  ): void {
    let envelope: UdpEnvelope;
    try {
      envelope = decodeUdpEnvelope(message);
    } catch {
      return;
    }
    const mapping = connection.udpMappings.get(
      udpMappingKey(envelope.serviceId, envelope.flowId),
    );
    if (!mapping) return;
    if (envelope.type === "close" || envelope.type === "error") {
      mapping.remote.dropMapping(mapping);
      return;
    }
    let payload = envelope.payload;
    if (envelope.type === "fragment") {
      try {
        const reassembled = mapping.reassembler.push(
          decodeUdpFragment(envelope),
        );
        if (reassembled === undefined) return;
        payload = reassembled;
      } catch {
        mapping.remote.dropMapping(mapping);
        return;
      }
    }
    mapping.remote.receiveReply(mapping, payload);
  }

  function clearCanonicalUdpMappings(connection: PeerConnection): void {
    for (const mapping of [...connection.udpMappings.values()]) {
      mapping.remote.dropMapping(mapping);
    }
    connection.udpMappings.clear();
  }

  function serviceStatusFor(service: PeerService): {
    available: boolean;
    error?: string;
  } {
    const localSourceError = localSourceErrors.get(service.id);
    if (localSourceError) {
      return { available: false, error: localSourceError };
    }
    if ("localPort" in service.source) return { available: true };
    if ("unixSocket" in service.source) {
      if (process.platform === "win32") {
        return { available: false, error: "Unix socket sources are unsupported on Windows" };
      }
      return { available: true };
    }
    const upstreamSource = service.source as Extract<PeerServiceSource, { peer: string }>;
    const entry = peerEntries.get(resolvePeerKey(upstreamSource.peer));
    const remote = entry?.current?.catalog?.services.find(
      ({ id }) => id === upstreamSource.service,
    );
    if (!entry?.current) return { available: false, error: "Upstream peer is offline" };
    if (!remote) return { available: false, error: "Upstream service is unauthorized or unavailable" };
    if (remote.available === false) return { available: false, error: remote.error };
    if (remote.kind === "udp") {
      if (service.kind === "udp" && entry.current.mux.udp.available()) {
        return { available: true };
      }
      return {
        available: false,
        error: service.kind === "udp"
          ? "Upstream UDP carrier is unavailable"
          : "Reverse UDP service channels are unsupported",
      };
    }
    if (service.kind === "udp") {
      return {
        available: false,
        error: "Upstream service transport kind is incompatible",
      };
    }
    return { available: true };
  }

  function serviceMappingFor(service: PeerService): LocalServiceMapping | undefined {
    if ("localPort" in service.source) {
      return {
        kind: service.kind === "udp" ? "udp" : "tcp",
        port: service.source.localPort,
      };
    }
    if ("unixSocket" in service.source) {
      return { kind: "tcp", endpoint: `unix://${service.source.unixSocket}` };
    }
    return undefined;
  }

  function presentationFor(
    service: Pick<PeerService, "id" | "name" | "kind"> &
      Pick<HomeRegistry["services"][number], "access">,
    mapping?: LocalServiceMapping,
  ): ServicePresentation {
    return createServicePresentation(service, gateway.port, mapping) ?? {
      id: service.id,
      name: service.name,
      access: service.access ?? (service.kind === "udp" ? "udp" : "tcp"),
      action: "copy-endpoint",
      icon: "port",
    };
  }

  function remoteServiceStatuses(): PeerRuntimeServiceStatus[] {
    const statuses: PeerRuntimeServiceStatus[] = [];
    const entries = [...peerEntries.values()].sort((left, right) =>
      left.definition.label.localeCompare(right.definition.label) ||
      left.definition.publicKey.localeCompare(right.definition.publicKey),
    );
    for (const entry of entries) {
      const catalog = entry.current?.catalog ?? entry.lastCatalog;
      const catalogAvailable = entry.current?.catalog !== undefined;
      for (const remote of catalog?.services ?? []) {
        if (remote.id === "home") continue;
        const presentation = presentationFor(
          remote,
          remoteBindingMappingFor(entry, remote.id),
        );
        const available = catalogAvailable && remote.available !== false;
        statuses.push({
          kind: remote.kind,
          source: { peer: entry.definition.label, service: remote.id },
          peer: entry.definition.label,
          available,
          ...presentation,
          ...(available
            ? {}
            : {
                error: remote.available === false
                  ? remote.error ?? "Service is unavailable"
                  : entry.current
                    ? entry.error ?? "Peer service catalog is unavailable"
                    : "Peer is offline",
              }),
        });
      }
    }
    return statuses;
  }

  function remoteBindingMappingFor(
    entry: PeerEntry,
    serviceId: string,
  ): LocalServiceMapping | undefined {
    const binding = [...bindings.values()].find((candidate) => {
      try {
        return (
          candidate.service === serviceId &&
          resolvePeerKey(candidate.peer) === entry.definition.publicKey
        );
      } catch {
        return false;
      }
    });
    if (!binding) return undefined;
    const runtime = bindingRuntimes.get(bindingKey(binding, resolvePeerKey));
    if (runtime?.kind === "udp") {
      return { kind: "udp", ...(runtime.port === undefined ? {} : { port: runtime.port }) };
    }
    if ("unixSocket" in binding.listen) {
      return { kind: "tcp", endpoint: `unix://${binding.listen.unixSocket}` };
    }
    const port = runtime?.port ?? binding.listen.localPort;
    return { kind: "tcp", ...(port === undefined ? {} : { port }) };
  }

  function runtimeStatus(): PeerRuntimeStatus {
    const localServices = [...services.values()].map((service) => {
      const serviceStatus = serviceStatusFor(service);
      return {
        kind: service.kind,
        source: { ...service.source },
        ...serviceStatus,
        ...presentationFor(service, serviceMappingFor(service)),
      };
    });
    return {
      role: "peer",
      state: stopped ? "stopped" : "running",
      peerKey,
      gateway: { port: gateway.port, url: gateway.url },
      connections: [...peerEntries.values()]
        .sort((left, right) => left.definition.label.localeCompare(right.definition.label))
        .map((entry) => ({
          label: entry.definition.label,
          publicKey: entry.definition.publicKey,
          connection: entry.definition.connection,
          status: stopped
            ? "stopped"
            : entry.current
              ? "connected"
              : entry.reconnectTask
                ? entry.definition.connection === "dial" ? "reconnecting" : "connecting"
                : "offline",
          generation: entry.generation,
          capability: entry.current?.capability ?? "pending",
          services:
            entry.current?.catalog?.services.length ??
            entry.lastCatalog?.services.length ??
            0,
          ...(entry.error ? { error: entry.error } : {}),
        })),
      services: [...localServices, ...remoteServiceStatuses()],
      bindings: [...bindings.values()].map((binding) => {
        const runtime = bindingRuntimes.get(bindingKey(binding, resolvePeerKey));
        const entry = peerEntries.get(resolvePeerKey(binding.peer));
        const remote = entry?.current?.catalog?.services.find(
          ({ id }) => id === binding.service,
        );
        const kind = peerBindingKind(binding);
        const unavailable = !entry?.current
          ? "Peer is offline"
          : !remote
            ? "Service is unauthorized or unavailable"
            : remote.available === false
              ? remote.error ?? "Service is unavailable"
              : kind === "udp" && remote.kind !== "udp"
                ? "Binding transport kind is incompatible with the remote service"
                : kind === "tcp" && remote.kind === "udp"
                  ? "Reverse UDP service channels are unsupported"
                  : kind === "udp" && runtime?.udp === undefined
                    ? "UDP binding is unavailable"
                    : undefined;
        return {
          peer: binding.peer,
          service: binding.service,
          listen: { ...binding.listen },
          kind,
          ...(runtime?.port === undefined ? {} : { port: runtime.port }),
          available: unavailable === undefined,
          ...(unavailable ? { error: unavailable } : {}),
        };
      }),
      ...(metricsServer
        ? {
            metrics: {
              host: metricsServer.host,
              port: metricsServer.port,
              url: metricsServer.url,
            },
          }
        : {}),
      pairing: pairing.snapshot(),
    };
  }

  async function stop(): Promise<void> {
    stopTask ??= (async () => {
      stopped = true;
      cancelPairingExpiry?.();
      cancelPairingExpiry = undefined;
      try {
        pairing.cancel();
      } catch {
        // An approval already being persisted is awaited by its own caller;
        // closing the candidate below still prevents new channel use.
      }
      closePairingCandidates();
      for (const [publicKey, pending] of pendingPeerPairings) {
        pending.reject(new Error("Peer runtime stopped during pairing"));
        pendingPeerPairings.delete(publicKey);
      }
      for (const timer of localSourceErrorTimers.values()) clearTimeout(timer);
      localSourceErrorTimers.clear();
      localSourceErrors.clear();
      for (const entry of peerEntries.values()) {
        entry.stopped = true;
        entry.current?.mux.close();
      }
      await cleanupStarted();
    })();
    return stopTask;
  }

  async function cleanupStarted(): Promise<void> {
    await cleanupAll([
      () => server.close(),
      () => closeServer(gateway?.server),
      () => metricsServer?.close(),
      ...[...bindingRuntimes.values()].map((runtime) => () => closeBinding(runtime)),
      ...[...homeServers.values()].map(
        (starting) => async () => (await starting).close(),
      ),
      ...(ownsDht ? [() => dht.destroy({ force: true })] : []),
    ]);
    bindingRuntimes.clear();
    metricsServer = undefined;
    homeServers.clear();
  }

  function resolvePeerKey(reference: string): string {
    return resolveConfiguredPeerKey(activeConfig.peers, reference);
  }
}

function resolveConfiguredPeerKey(
  peers: readonly PeerDefinition[],
  reference: string,
): string {
  if (/^[0-9a-f]{64}$/u.test(reference)) {
    if (!peers.some(({ publicKey }) => publicKey === reference)) {
      throw new Error(`unknown peer public key: ${reference}`);
    }
    return reference;
  }
  const peer = peers.find(({ label }) => label === reference);
  if (!peer) throw new Error(`unknown peer label: ${reference}`);
  return peer.publicKey;
}

function bindingKey(
  binding: PeerBinding,
  resolvePeer?: (reference: string) => string,
): string {
  const peerKey = resolvePeer ? resolvePeer(binding.peer) : binding.peer;
  return `${peerKey}\u0000${binding.service}`;
}

async function waitForConnect(stream: DhtStream, timeoutMs: number): Promise<void> {
  if (stream.connected) return;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("connect timeout must be a positive finite number");
  }
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
      cleanup();
      reject(new Error(`Peer connection timed out after ${timeoutMs}ms`));
    }, timeoutMs);
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
      reject(new Error("Peer connection closed before handshake"));
    };
    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      stream.off("connect", onConnect);
      stream.off("error", onError);
      stream.off("close", onClose);
    };
    stream.once("connect", onConnect);
    stream.once("error", onError);
    stream.once("close", onClose);
  });
}

async function onceClosed(stream: DhtStream): Promise<void> {
  if (stream.destroyed) return;
  await once(stream, "close").catch(() => undefined);
}

async function connectLoopback(port: number): Promise<Socket> {
  const socket = createConnection({ host: "127.0.0.1", port, allowHalfOpen: true });
  await waitForSocket(socket);
  return socket;
}

async function connectUnixSocket(socketPath: string): Promise<Socket> {
  if (process.platform === "win32") {
    throw new Error("Unix socket sources are unsupported on Windows");
  }
  const socket = createConnection({ path: socketPath, allowHalfOpen: true });
  await waitForSocket(socket);
  return socket;
}

async function waitForSocket(socket: Socket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onConnect = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const cleanup = (): void => {
      socket.off("connect", onConnect);
      socket.off("error", onError);
    };
    socket.once("connect", onConnect);
    socket.once("error", onError);
  });
}

async function listenBinding(
  server: Server,
  listen: PeerBinding["listen"],
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    const onListening = (): void => {
      server.off("error", reject);
      resolve();
    };
    server.once("listening", onListening);
    if ("localPort" in listen) {
      server.listen({ host: "127.0.0.1", port: listen.localPort });
    } else {
      server.listen(listen.unixSocket);
    }
  });
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server || !server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function unlinkOwnedSocket(
  socketPath: string,
  expected?: { dev: number; ino: number },
): Promise<void> {
  try {
    const stat = await lstat(socketPath);
    if (!stat.isSocket()) return;
    if (expected && (stat.dev !== expected.dev || stat.ino !== expected.ino)) return;
    await unlink(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function waitWithAbort<T>(
  promise: Promise<T>,
  signal: CancellationSignal | undefined,
  deadline: number,
  now: () => number = Date.now,
): Promise<T> {
  throwIfAborted(signal);
  if (now() >= deadline) throw new Error("service acquisition timed out");
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error("service acquisition cancelled"));
    signal?.addEventListener("abort", onAbort);
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}

function throwIfAborted(signal: CancellationSignal | undefined): void {
  if (signal?.aborted) throw new Error("service acquisition cancelled");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function flowKey(flowId: Uint8Array): string {
  return b4a.toString(flowId, "hex");
}

function udpMappingKey(serviceId: string, flowId: Uint8Array): string {
  return `${serviceId}:${flowKey(flowId)}`;
}

async function delay(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}
