import type { PeerConfig, PeerDefinition, PeerService } from "../config.js";

export const peerMetricNames = [
  "kepos_publisher_subscriber_connected",
  "kepos_publisher_subscriber_last_connected_timestamp_seconds",
  "kepos_publisher_subscriber_connection_bytes",
  "kepos_publisher_subscriber_bytes_total",
  "kepos_publisher_service_authorized",
  "kepos_publisher_service_active_channels",
  "kepos_publisher_service_bytes_total",
] as const;

/** Existing dashboard and Kosmos scrape names are intentionally unchanged. */
export const publisherMetricNames = peerMetricNames;
export type PeerMetricName = (typeof peerMetricNames)[number];
export type PublisherMetricName = PeerMetricName;

export type PeerMetricsDirection =
  | "publisher_to_subscriber"
  | "subscriber_to_publisher";
export type PublisherMetricsDirection = PeerMetricsDirection;

export interface PeerMetricsContext {
  subscriberKey: string;
  connectionId: string;
}
export type PublisherMetricsContext = PeerMetricsContext;

export interface PeerMetricsHooks {
  connectionActivated: (context: PeerMetricsContext) => void;
  connectionClosed: (context: PeerMetricsContext) => void;
  serviceChannelOpened: (context: PeerMetricsContext, serviceId: string) => void;
  serviceChannelClosed: (context: PeerMetricsContext, serviceId: string) => void;
  serviceBytes: (
    context: PeerMetricsContext,
    serviceId: string,
    direction: PeerMetricsDirection,
    bytes: number,
  ) => void;
}
export type PublisherMetricsHooks = PeerMetricsHooks;

export interface PeerMetricsPolicy {
  peers: readonly Pick<PeerDefinition, "publicKey" | "label">[];
  services: readonly Pick<PeerService, "id" | "allow">[];
}

export function peerMetricsPolicy(config: PeerConfig): PeerMetricsPolicy {
  return {
    peers: config.peers,
    services: config.services,
  };
}

interface PeerState {
  peer: Pick<PeerDefinition, "publicKey" | "label">;
  connected: boolean;
  lastConnectedSeconds: number;
  connectionId?: string;
  connectionBytes: Directions;
  activeChannels: Map<string, number>;
}

interface CounterState {
  peer: Directions;
  services: Map<string, Directions>;
}

type Directions = Record<PeerMetricsDirection, number>;

const directions: readonly PeerMetricsDirection[] = [
  "publisher_to_subscriber",
  "subscriber_to_publisher",
];

export interface PeerMetricsRecorder extends PeerMetricsHooks {
  applyPolicy: (policy: PeerMetricsPolicy) => void;
  render: () => string;
}

export function createPeerMetricsRecorder(
  policy: PeerMetricsPolicy,
  now: () => number = Date.now,
): PeerMetricsRecorder {
  const peers = new Map<string, PeerState>();
  const counters = new Map<string, CounterState>();
  let services = new Map<string, PeerMetricsPolicy["services"][number]>();
  applyPolicy(policy);

  function applyPolicy(nextPolicy: PeerMetricsPolicy): void {
    const previous = new Map(peers);
    services = new Map(nextPolicy.services.map((service) => [service.id, service]));
    const nextPeers = new Map<string, PeerState>();
    const allowedPeers = new Set(nextPolicy.peers.map((peer) => peer.publicKey));
    for (const key of counters.keys()) {
      if (!allowedPeers.has(key)) counters.delete(key);
    }
    for (const peer of nextPolicy.peers) {
      const old = previous.get(peer.publicKey);
      const state = old
        ? { ...old, peer }
        : {
            peer,
            connected: false,
            lastConnectedSeconds: 0,
            connectionBytes: emptyDirections(),
            activeChannels: new Map<string, number>(),
          };
      for (const serviceId of state.activeChannels.keys()) {
        const service = services.get(serviceId);
        if (!service) {
          state.activeChannels.delete(serviceId);
        }
      }
      const counter = ensureCounter(peer.publicKey);
      for (const serviceId of counter.services.keys()) {
        if (!services.has(serviceId)) counter.services.delete(serviceId);
      }
      nextPeers.set(peer.publicKey, state);
    }
    peers.clear();
    for (const [key, value] of nextPeers) peers.set(key, value);
  }

  function connectionActivated(context: PeerMetricsContext): void {
    const state = peers.get(context.subscriberKey);
    if (!state) return;
    state.connected = true;
    state.connectionId = context.connectionId;
    state.lastConnectedSeconds = now() / 1_000;
    state.connectionBytes = emptyDirections();
    state.activeChannels.clear();
  }

  function connectionClosed(context: PeerMetricsContext): void {
    const state = peers.get(context.subscriberKey);
    if (!state || state.connectionId !== context.connectionId) return;
    state.connected = false;
    state.connectionId = undefined;
    state.connectionBytes = emptyDirections();
    state.activeChannels.clear();
  }

  function serviceChannelOpened(
    context: PeerMetricsContext,
    serviceId: string,
  ): void {
    const state = peers.get(context.subscriberKey);
    const service = services.get(serviceId);
    if (
      !state ||
      state.connectionId !== context.connectionId ||
      !service ||
      !serviceAllows(service, context.subscriberKey)
    ) {
      return;
    }
    state.activeChannels.set(serviceId, (state.activeChannels.get(serviceId) ?? 0) + 1);
    const counter = ensureCounter(context.subscriberKey);
    if (!counter.services.has(serviceId)) {
      counter.services.set(serviceId, emptyDirections());
    }
  }

  function serviceChannelClosed(
    context: PeerMetricsContext,
    serviceId: string,
  ): void {
    const state = peers.get(context.subscriberKey);
    if (!state || state.connectionId !== context.connectionId) return;
    const count = state.activeChannels.get(serviceId) ?? 0;
    if (count <= 1) state.activeChannels.delete(serviceId);
    else state.activeChannels.set(serviceId, count - 1);
  }

  function serviceBytes(
    context: PeerMetricsContext,
    serviceId: string,
    direction: PeerMetricsDirection,
    bytes: number,
  ): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) return;
    const state = peers.get(context.subscriberKey);
    const service = services.get(serviceId);
    const activeChannels = state?.activeChannels.get(serviceId) ?? 0;
    if (
      !state ||
      !service ||
      (!serviceAllows(service, context.subscriberKey) &&
        (state.connectionId !== context.connectionId || activeChannels <= 0))
    ) {
      return;
    }
    if (state.connectionId === context.connectionId) {
      state.connectionBytes[direction] += bytes;
    }
    const counter = ensureCounter(context.subscriberKey);
    counter.peer[direction] += bytes;
    const serviceCounter = counter.services.get(serviceId) ?? emptyDirections();
    serviceCounter[direction] += bytes;
    counter.services.set(serviceId, serviceCounter);
  }

  function ensureCounter(peerKey: string): CounterState {
    const existing = counters.get(peerKey);
    if (existing) return existing;
    const created = { peer: emptyDirections(), services: new Map<string, Directions>() };
    counters.set(peerKey, created);
    return created;
  }

  return {
    applyPolicy,
    connectionActivated,
    connectionClosed,
    serviceChannelOpened,
    serviceChannelClosed,
    serviceBytes,
    render: () => renderMetrics(peers, counters, services),
  };
}

function renderMetrics(
  peers: Map<string, PeerState>,
  counters: Map<string, CounterState>,
  services: Map<string, PeerMetricsPolicy["services"][number]>,
): string {
  const lines: string[] = [];
  const write = (name: PeerMetricName, type: "gauge" | "counter", help: string): void => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
  };
  const sortedPeers = [...peers.entries()].sort(([, left], [, right]) =>
    left.peer.label.localeCompare(right.peer.label) ||
    left.peer.publicKey.localeCompare(right.peer.publicKey),
  );
  const sortedServices = [...services.values()].sort((left, right) => left.id.localeCompare(right.id));

  write(
    "kepos_publisher_subscriber_connected",
    "gauge",
    "Whether the configured subscriber device currently has an active connection.",
  );
  for (const [, state] of sortedPeers) {
    lines.push(sample("kepos_publisher_subscriber_connected", peerLabels(state.peer), state.connected ? 1 : 0));
  }

  write(
    "kepos_publisher_subscriber_last_connected_timestamp_seconds",
    "gauge",
    "Unix timestamp of the most recent successful subscriber connection.",
  );
  for (const [, state] of sortedPeers) {
    lines.push(sample("kepos_publisher_subscriber_last_connected_timestamp_seconds", peerLabels(state.peer), state.lastConnectedSeconds));
  }

  write(
    "kepos_publisher_subscriber_connection_bytes",
    "gauge",
    "Payload bytes transferred on the current subscriber connection.",
  );
  for (const [, state] of sortedPeers) {
    for (const direction of directions) {
      lines.push(sample("kepos_publisher_subscriber_connection_bytes", { ...peerLabels(state.peer), direction }, state.connectionBytes[direction]));
    }
  }

  write(
    "kepos_publisher_subscriber_bytes_total",
    "counter",
    "Cumulative published-service payload bytes transferred for a subscriber device.",
  );
  for (const [key, state] of sortedPeers) {
    const counter = counters.get(key) ?? {
      peer: emptyDirections(),
      services: new Map<string, Directions>(),
    };
    for (const direction of directions) {
      lines.push(sample("kepos_publisher_subscriber_bytes_total", { ...peerLabels(state.peer), direction }, counter.peer[direction]));
    }
  }

  write(
    "kepos_publisher_service_authorized",
    "gauge",
    "Whether a configured subscriber device is authorized to use a published service.",
  );
  for (const [, state] of sortedPeers) {
    for (const service of sortedServices) {
      lines.push(sample("kepos_publisher_service_authorized", { ...peerLabels(state.peer), service: service.id }, serviceAllows(service, state.peer.publicKey) ? 1 : 0));
    }
  }

  write(
    "kepos_publisher_service_active_channels",
    "gauge",
    "Number of active channels for a configured subscriber device and published service.",
  );
  for (const [, state] of sortedPeers) {
    for (const service of sortedServices) {
      lines.push(sample("kepos_publisher_service_active_channels", { ...peerLabels(state.peer), service: service.id }, state.activeChannels.get(service.id) ?? 0));
    }
  }

  write(
    "kepos_publisher_service_bytes_total",
    "counter",
    "Cumulative published-service payload bytes transferred by direction.",
  );
  for (const [key, state] of sortedPeers) {
    const counter = counters.get(key) ?? {
      peer: emptyDirections(),
      services: new Map<string, Directions>(),
    };
    for (const service of sortedServices) {
      const serviceCounter = counter.services.get(service.id) ?? emptyDirections();
      for (const direction of directions) {
        lines.push(sample("kepos_publisher_service_bytes_total", { ...peerLabels(state.peer), service: service.id, direction }, serviceCounter[direction]));
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

function peerLabels(peer: Pick<PeerDefinition, "publicKey" | "label">): Record<string, string> {
  return { subscriber_label: peer.label, subscriber_id: peer.publicKey.slice(0, 16) };
}

function sample(name: string, labels: Record<string, string>, value: number): string {
  const encoded = Object.entries(labels)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, field]) => `${key}="${escapeLabel(field)}"`)
    .join(",");
  return `${name}{${encoded}} ${Number.isFinite(value) ? value : 0}`;
}

function escapeLabel(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"');
}

function emptyDirections(): Directions {
  return { publisher_to_subscriber: 0, subscriber_to_publisher: 0 };
}

function serviceAllows(
  service: Pick<PeerService, "allow">,
  peerKey: string,
): boolean {
  return service.allow.includes(peerKey);
}
