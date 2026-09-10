import b4a from "b4a";
import crypto from "hypercore-crypto";
import type { Duplex } from "node:stream";

import {
  decodeUdpEnvelope,
  decodeUdpFragment,
  encodeUdpDataEnvelopes,
  encodeUdpEnvelope,
  UdpDatagramReassembler,
  boundedError,
  type UdpPublisherRemote,
  type UdpSendResult,
} from "../mux/udp.js";
import {
  holepunchObservation,
  dhtStatsSnapshot,
  type DhtKeyPair,
  type DhtNode,
  type DhtStream,
} from "../mux/hyperdht.js";
import type { EmitObservation, Observe } from "../mux/observability.js";
import { connectionOptionsForRoute } from "../mux/route.js";
import {
  createPublisherConnection,
} from "./subscriber.js";
import {
  readHomeRegistryFromConnection,
} from "./registry-client.js";
import type { HomeRegistry } from "../home/registry.js";
import type { PublisherServiceSource } from "../config.js";

const defaultPollIntervalMs = 1_000;
const defaultConnectionTimeoutMs = 20_000;

export interface UpstreamServiceDefinition {
  id: string;
  kind?: "tcp" | "http" | "udp";
  source: PublisherServiceSource;
}

export interface UpstreamServiceStatus {
  available: boolean;
  error?: string;
}

export interface UpstreamConnectionManagerOptions {
  dht: DhtNode;
  keyPair: DhtKeyPair;
  now?: () => number;
  observe?: Observe;
  log?: (line: string) => void;
  pollIntervalMs?: number;
  connectionTimeoutMs?: number;
  onStatusChange?: () => void;
}

export interface RunningUpstreamConnectionManager {
  reconcile: (services: readonly UpstreamServiceDefinition[]) => void;
  status: (
    source: PublisherServiceSource,
    kind?: "tcp" | "http" | "udp",
  ) => UpstreamServiceStatus;
  open: (
    source: PublisherServiceSource,
    kind?: "tcp" | "http" | "udp",
  ) => Promise<Duplex>;
  udpRemote: (
    source: PublisherServiceSource,
    onReply: (flowId: Uint8Array, payload: Uint8Array) => void,
  ) => UdpPublisherRemote | undefined;
  stop: () => Promise<void>;
}

interface UpstreamEntry {
  publisherKey: string;
  connection: ReturnType<typeof createPublisherConnection>;
  catalog?: HomeRegistry;
  generation: number;
  connectionError?: string;
  udpError?: string;
  refreshTask?: Promise<void>;
  refreshTimer?: ReturnType<typeof setTimeout>;
  started: boolean;
  closed: boolean;
  mappings: Map<string, UpstreamUdpMapping>;
  remotes: Set<UpstreamUdpRemote>;
  unsubscribeUdpMessage?: () => void;
  unsubscribeUdpReset?: () => void;
  unsubscribeUdpError?: () => void;
}

interface UpstreamUdpMapping {
  entry: UpstreamEntry;
  remote: UpstreamUdpRemote;
  sourceServiceId: string;
  upstreamFlowId: Uint8Array;
  downstreamFlowId: Uint8Array;
  reassembler: UdpDatagramReassembler;
  generation: number;
}

class UpstreamUdpRemote implements UdpPublisherRemote {
  private readonly mappings = new Map<string, UpstreamUdpMapping>();
  private closed = false;

  constructor(
    private readonly entry: UpstreamEntry,
    private readonly sourceServiceId: string,
    private readonly onReply: (flowId: Uint8Array, payload: Uint8Array) => void,
    private readonly now: () => number,
  ) {}

  available(): boolean {
    const service = this.entry.catalog?.services.find(
      ({ id }) => id === this.sourceServiceId,
    );
    return (
      !this.closed &&
      !this.entry.closed &&
      this.entry.connection.status() === "connected" &&
      this.entry.generation > 0 &&
      service?.kind === "udp" &&
      service.available !== false &&
      this.entry.connection.udp?.available() === true
    );
  }

  async send(
    downstreamFlowId: Uint8Array,
    payload: Uint8Array,
    messageId: number,
  ): Promise<UdpSendResult> {
    if (!this.available()) {
      return { ok: false, error: upstreamUdpUnavailable };
    }
    const key = flowKey(downstreamFlowId);
    let mapping = this.mappings.get(key);
    if (!mapping || mapping.generation !== this.entry.generation) {
      if (mapping) this.removeMapping(mapping);
      const upstreamFlowId = crypto.randomBytes(16);
      mapping = {
        entry: this.entry,
        remote: this,
        sourceServiceId: this.sourceServiceId,
        upstreamFlowId,
        downstreamFlowId: b4a.from(downstreamFlowId),
        generation: this.entry.generation,
        reassembler: new UdpDatagramReassembler({
          now: this.now,
          onDrop: () => undefined,
        }),
      };
      this.mappings.set(key, mapping);
      this.entry.mappings.set(
        mappingKey(this.sourceServiceId, upstreamFlowId),
        mapping,
      );
    }

    let envelopes: Uint8Array[];
    try {
      envelopes = encodeUdpDataEnvelopes({
        serviceId: this.sourceServiceId,
        flowId: mapping.upstreamFlowId,
        payload,
        messageId,
      });
    } catch (error) {
      return { ok: false, error: boundedError(errorMessage(error)) };
    }
    const transport = this.entry.connection.udp;
    if (!transport) return { ok: false, error: upstreamUdpUnavailable };
    try {
      const results = await Promise.all(envelopes.map((envelope) => transport.send(envelope)));
      for (const result of results) {
        if (!result.ok) {
          this.removeMapping(mapping);
          return { ok: false, error: result.error ?? upstreamUdpUnavailable };
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
    const transport = this.entry.connection.udp;
    if (!transport) return;
    const envelope = encodeUdpEnvelope({
      type: "close",
      serviceId: this.sourceServiceId,
      flowId: mapping.upstreamFlowId,
      payload: new Uint8Array(),
    });
    void transport.send(envelope);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const mapping of [...this.mappings.values()]) this.removeMapping(mapping);
    this.entry.remotes.delete(this);
  }

  receiveReply(mapping: UpstreamUdpMapping, payload: Uint8Array): void {
    if (this.closed || this.mappings.get(flowKey(mapping.downstreamFlowId)) !== mapping) {
      return;
    }
    this.onReply(mapping.downstreamFlowId, payload);
  }

  clearGeneration(): void {
    for (const mapping of [...this.mappings.values()]) this.removeMapping(mapping);
  }

  private removeMapping(mapping: UpstreamUdpMapping): void {
    if (this.mappings.get(flowKey(mapping.downstreamFlowId)) !== mapping) return;
    this.mappings.delete(flowKey(mapping.downstreamFlowId));
    this.entry.mappings.delete(mappingKey(mapping.sourceServiceId, mapping.upstreamFlowId));
    mapping.reassembler.clear();
  }
}

const upstreamUnavailable = "Upstream publisher is unreachable";
const upstreamUdpUnavailable = "Upstream UDP carrier is unavailable";
const upstreamMissing = "Upstream service is missing or unauthorized";
const upstreamMismatch = "Upstream service transport kind is incompatible";

export function createUpstreamConnectionManager(
  options: UpstreamConnectionManagerOptions,
): RunningUpstreamConnectionManager {
  const now = options.now ?? Date.now;
  const pollIntervalMs = options.pollIntervalMs ?? defaultPollIntervalMs;
  const connectionTimeoutMs = options.connectionTimeoutMs ?? defaultConnectionTimeoutMs;
  const entries = new Map<string, UpstreamEntry>();
  let stopped = false;

  const reconcile = (services: readonly UpstreamServiceDefinition[]): void => {
    if (stopped) return;
    const desired = new Set<string>();
    for (const service of services) {
      if (!("publisherKey" in service.source)) continue;
      desired.add(service.source.publisherKey);
      const entry = entryFor(service.source.publisherKey);
      if (!entry.started) {
        entry.started = true;
        entry.connection.startInBackground();
        scheduleRefresh(entry, 0);
      }
    }
    for (const [publisherKey, entry] of entries) {
      if (desired.has(publisherKey)) continue;
      entries.delete(publisherKey);
      void closeEntry(entry);
    }
  };

  const status = (
    source: PublisherServiceSource,
    kind: "tcp" | "http" | "udp" = "tcp",
  ): UpstreamServiceStatus => {
    if (!("publisherKey" in source)) return { available: true };
    const entry = entries.get(source.publisherKey);
    if (!entry || entry.closed) return unavailable(upstreamUnavailable);
    if (entry.connection.status() !== "connected" || !entry.catalog) {
      return unavailable(
        entry.connectionError ?? upstreamUnavailable,
      );
    }
    const service = entry.catalog.services.find(({ id }) => id === source.serviceId);
    if (!service) return unavailable(upstreamMissing);
    if (service.available === false) {
      return unavailable(service.error ?? upstreamMissing);
    }
    const expected = kind === "udp" ? "udp" : "tcp";
    if (service.kind !== expected) return unavailable(upstreamMismatch);
    if (kind === "udp" && entry.connection.udp?.available() !== true) {
      return unavailable(entry.udpError ?? upstreamUdpUnavailable);
    }
    return { available: true };
  };

  const open = async (
    source: PublisherServiceSource,
    kind: "tcp" | "http" | "udp" = "tcp",
  ): Promise<Duplex> => {
    if (!("publisherKey" in source)) {
      throw new Error("Publisher upstream open requires an upstream source");
    }
    const entry = entries.get(source.publisherKey);
    if (!entry || entry.closed) throw new Error(upstreamUnavailable);
    if (!entry.catalog) await refresh(entry);
    const available = status(source, kind);
    if (!available.available) throw new Error(available.error ?? upstreamUnavailable);
    try {
      return await entry.connection.open(source.serviceId);
    } catch (error) {
      const message = boundedError(errorMessage(error));
      entry.connectionError = message;
      notify();
      throw new Error(message, { cause: error });
    }
  };

  const udpRemote = (
    source: PublisherServiceSource,
    onReply: (flowId: Uint8Array, payload: Uint8Array) => void,
  ): UdpPublisherRemote | undefined => {
    if (!("publisherKey" in source)) return undefined;
    const entry = entries.get(source.publisherKey);
    if (!entry || !status(source, "udp").available) return undefined;
    const remote = new UpstreamUdpRemote(entry, source.serviceId, onReply, now);
    entry.remotes.add(remote);
    return remote;
  };

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    const pending = [...entries.values()].map(closeEntry);
    entries.clear();
    await Promise.allSettled(pending);
  };

  return { reconcile, status, open, udpRemote, stop };

  function entryFor(publisherKey: string): UpstreamEntry {
    const existing = entries.get(publisherKey);
    if (existing) return existing;
    let entry!: UpstreamEntry;
    const connection = createPublisherConnection({
      connect: (observe) => connectUpstream(publisherKey, observe),
      connectTimeoutMs: connectionTimeoutMs,
      dhtStats: () => dhtStatsSnapshot(options.dht),
      log: options.log,
      now,
      observe: options.observe,
      observationRole: "publisher",
      onConnected: (generation) => {
        entry.generation = generation;
        entry.catalog = undefined;
        entry.connectionError = undefined;
        entry.udpError = undefined;
        clearMappings(entry);
        notify();
        scheduleRefresh(entry, 0);
      },
      onDisconnected: (_generation, reason) => {
        entry.catalog = undefined;
        entry.connectionError = upstreamUnavailable;
        clearMappings(entry);
        notify();
      },
      route: "auto",
      sleep: delay,
    });
    entry = {
      publisherKey,
      connection,
      generation: 0,
      started: false,
      closed: false,
      mappings: new Map(),
      remotes: new Set(),
    };
    entry.unsubscribeUdpMessage = connection.udp?.onMessage((message) => {
      receiveUdp(entry, message);
    });
    entry.unsubscribeUdpReset = connection.udp?.onReset(() => {
      clearMappings(entry);
      notify();
    });
    entry.unsubscribeUdpError = connection.udp?.onError((error) => {
      entry.udpError = boundedError(error);
      notify();
    });
    entries.set(publisherKey, entry);
    return entry;
  }

  function connectUpstream(
    publisherKey: string,
    observe: EmitObservation,
  ): DhtStream {
    return options.dht.connect(Buffer.from(publisherKey, "hex"), {
      keyPair: options.keyPair,
      ...connectionOptionsForRoute("auto"),
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
    });
  }

  function scheduleRefresh(entry: UpstreamEntry, delayMs: number): void {
    if (stopped || entry.closed) return;
    if (entry.refreshTimer) clearTimeout(entry.refreshTimer);
    const timer = setTimeout(() => {
      entry.refreshTimer = undefined;
      void refresh(entry).finally(() => scheduleRefresh(entry, pollIntervalMs));
    }, delayMs);
    timer.unref?.();
    entry.refreshTimer = timer;
  }

  function refresh(entry: UpstreamEntry): Promise<void> {
    if (entry.closed || stopped) return Promise.resolve();
    if (entry.refreshTask) return entry.refreshTask;
    entry.refreshTask = (async () => {
      try {
        const connection = await entry.connection.open("home");
        const catalog = await readHomeRegistryFromConnection(connection);
        if (catalog.publisher.publisherKey !== entry.publisherKey) {
          throw new Error("Upstream Home identity does not match its configured publisher");
        }
        if (entry.closed || stopped) return;
        entry.catalog = catalog;
        entry.connectionError = undefined;
        notify();
      } catch (error) {
        if (entry.closed || stopped) return;
        entry.catalog = undefined;
        entry.connectionError = classifyRefreshError(error);
        notify();
      }
    })().finally(() => {
      entry.refreshTask = undefined;
    });
    return entry.refreshTask;
  }

  async function closeEntry(entry: UpstreamEntry): Promise<void> {
    if (entry.closed) return;
    entry.closed = true;
    if (entry.refreshTimer) clearTimeout(entry.refreshTimer);
    entry.refreshTimer = undefined;
    entry.unsubscribeUdpMessage?.();
    entry.unsubscribeUdpReset?.();
    entry.unsubscribeUdpError?.();
    clearMappings(entry);
    for (const remote of [...entry.remotes]) remote.close();
    await entry.connection.stop().catch(() => undefined);
    await entry.refreshTask?.catch(() => undefined);
  }

  function clearMappings(entry: UpstreamEntry): void {
    entry.mappings.clear();
    for (const remote of entry.remotes) remote.clearGeneration();
  }

  function receiveUdp(entry: UpstreamEntry, message: Uint8Array): void {
    if (stopped || entry.closed) return;
    let envelope;
    try {
      envelope = decodeUdpEnvelope(message);
    } catch {
      return;
    }
    const mapping = entry.mappings.get(mappingKey(envelope.serviceId, envelope.flowId));
    if (!mapping || mapping.generation !== entry.generation) return;
    if (envelope.type === "error" || envelope.type === "close") {
      mapping.remote.closeFlow(mapping.downstreamFlowId);
      return;
    }
    let payload = envelope.payload;
    if (envelope.type === "fragment") {
      try {
        const reassembled = mapping.reassembler.push(decodeUdpFragment(envelope));
        if (reassembled === undefined) return;
        payload = reassembled;
      } catch {
        return;
      }
    }
    mapping.remote.receiveReply(mapping, payload);
  }

  function notify(): void {
    try {
      options.onStatusChange?.();
    } catch {
      // Availability observers cannot affect forwarding.
    }
  }
}

function unavailable(error: string): UpstreamServiceStatus {
  return { available: false, error: boundedError(error) };
}

function classifyRefreshError(error: unknown): string {
  const message = errorMessage(error);
  if (message.includes("missing") || message.includes("unauthorized")) {
    return upstreamMissing;
  }
  if (message.includes("incompatible")) return upstreamMismatch;
  return boundedError(message || upstreamUnavailable);
}

function mappingKey(serviceId: string, flowId: Uint8Array): string {
  return `${serviceId}:${flowKey(flowId)}`;
}

function flowKey(flowId: Uint8Array): string {
  return b4a.toString(flowId, "hex");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function delay(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}
