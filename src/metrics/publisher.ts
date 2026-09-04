import type { SubscriberDevice } from "../config.js";
import type { PublisherRuntimePolicy } from "../runtime/publisher.js";

export const publisherMetricNames = [
  "kepos_publisher_subscriber_connected",
  "kepos_publisher_subscriber_last_connected_timestamp_seconds",
  "kepos_publisher_subscriber_connection_bytes",
  "kepos_publisher_subscriber_bytes_total",
  "kepos_publisher_service_authorized",
  "kepos_publisher_service_active_channels",
  "kepos_publisher_service_bytes_total",
] as const;

export type PublisherMetricName = (typeof publisherMetricNames)[number];

export type PublisherMetricsDirection =
  | "publisher_to_subscriber"
  | "subscriber_to_publisher";

export interface PublisherMetricsContext {
  subscriberKey: string;
  connectionId: string;
}

export interface PublisherMetricsHooks {
  connectionActivated: (context: PublisherMetricsContext) => void;
  connectionClosed: (context: PublisherMetricsContext) => void;
  serviceChannelOpened: (
    context: PublisherMetricsContext,
    serviceId: string,
  ) => void;
  serviceChannelClosed: (
    context: PublisherMetricsContext,
    serviceId: string,
  ) => void;
  serviceBytes: (
    context: PublisherMetricsContext,
    serviceId: string,
    direction: PublisherMetricsDirection,
    bytes: number,
  ) => void;
}

interface DeviceState {
  device: SubscriberDevice;
  connected: boolean;
  lastConnectedSeconds: number;
  connectionId?: string;
  connectionBytes: Record<PublisherMetricsDirection, number>;
  activeChannels: Map<string, number>;
}

interface CounterState {
  subscriber: Record<PublisherMetricsDirection, number>;
  services: Map<string, Record<PublisherMetricsDirection, number>>;
}

const directions: readonly PublisherMetricsDirection[] = [
  "publisher_to_subscriber",
  "subscriber_to_publisher",
];

export interface PublisherMetricsRecorder extends PublisherMetricsHooks {
  applyPolicy: (policy: PublisherRuntimePolicy) => void;
  render: () => string;
}

export function createPublisherMetricsRecorder(
  policy: PublisherRuntimePolicy,
  now: () => number = Date.now,
): PublisherMetricsRecorder {
  const devices = new Map<string, DeviceState>();
  const counters = new Map<string, CounterState>();
  let services = new Map<string, PublisherRuntimePolicy["services"][number]>();
  applyPolicy(policy);

  function applyPolicy(nextPolicy: PublisherRuntimePolicy): void {
    const previousDevices = new Map(devices);
    services = new Map(nextPolicy.services.map((service) => [service.id, service]));
    const nextDevices = new Map<string, DeviceState>();
    const nextSubscriberKeys = new Set(
      nextPolicy.subscribers.map((device) => device.publicKey),
    );
    for (const subscriberKey of counters.keys()) {
      if (!nextSubscriberKeys.has(subscriberKey)) counters.delete(subscriberKey);
    }
    for (const device of nextPolicy.subscribers) {
      const previous = previousDevices.get(device.publicKey);
      nextDevices.set(
        device.publicKey,
        previous
          ? { ...previous, device }
          : {
              device,
              connected: false,
              lastConnectedSeconds: 0,
              connectionBytes: emptyDirections(),
              activeChannels: new Map(),
          },
      );
      const counter = ensureCounter(device.publicKey);
      for (const serviceId of counter.services.keys()) {
        const nextService = services.get(serviceId);
        if (nextService === undefined) {
          counter.services.delete(serviceId);
        }
      }
    }
    for (const state of nextDevices.values()) {
      for (const serviceId of state.activeChannels.keys()) {
        const service = services.get(serviceId);
        if (service === undefined) {
          state.activeChannels.delete(serviceId);
        }
      }
    }
    devices.clear();
    for (const [key, value] of nextDevices) devices.set(key, value);
  }

  function connectionActivated(context: PublisherMetricsContext): void {
    const state = devices.get(context.subscriberKey);
    if (!state) return;
    state.connected = true;
    state.connectionId = context.connectionId;
    state.lastConnectedSeconds = now() / 1_000;
    state.connectionBytes = emptyDirections();
    state.activeChannels.clear();
  }

  function connectionClosed(context: PublisherMetricsContext): void {
    const state = devices.get(context.subscriberKey);
    if (!state || state.connectionId !== context.connectionId) return;
    state.connected = false;
    state.connectionId = undefined;
    state.connectionBytes = emptyDirections();
    state.activeChannels.clear();
  }

  function serviceChannelOpened(
    context: PublisherMetricsContext,
    serviceId: string,
  ): void {
    const service = services.get(serviceId);
    const state = devices.get(context.subscriberKey);
    if (
      !state ||
      state.connectionId !== context.connectionId ||
      service === undefined ||
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
    context: PublisherMetricsContext,
    serviceId: string,
  ): void {
    const state = devices.get(context.subscriberKey);
    if (!state || state.connectionId !== context.connectionId) return;
    const count = state.activeChannels.get(serviceId) ?? 0;
    if (count <= 1) state.activeChannels.delete(serviceId);
    else state.activeChannels.set(serviceId, count - 1);
  }

  function serviceBytes(
    context: PublisherMetricsContext,
    serviceId: string,
    direction: PublisherMetricsDirection,
    bytes: number,
  ): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) return;
    const state = devices.get(context.subscriberKey);
    const service = services.get(serviceId);
    const activeChannels = state?.activeChannels.get(serviceId) ?? 0;
    if (
      !state ||
      service === undefined ||
      (!serviceAllows(service, context.subscriberKey) &&
        (state.connectionId !== context.connectionId || activeChannels <= 0))
    ) {
      return;
    }
    if (state.connectionId === context.connectionId) {
      state.connectionBytes[direction] += bytes;
    }
    const counter = ensureCounter(context.subscriberKey);
    counter.subscriber[direction] += bytes;
    const serviceCounter =
      counter.services.get(serviceId) ?? emptyDirections();
    serviceCounter[direction] += bytes;
    counter.services.set(serviceId, serviceCounter);
  }

  function ensureCounter(subscriberKey: string): CounterState {
    const existing = counters.get(subscriberKey);
    if (existing) return existing;
    const created: CounterState = {
      subscriber: emptyDirections(),
      services: new Map(),
    };
    counters.set(subscriberKey, created);
    return created;
  }

  return {
    applyPolicy,
    connectionActivated,
    connectionClosed,
    serviceChannelOpened,
    serviceChannelClosed,
    serviceBytes,
    render: () => renderMetrics(devices, counters, services),
  };
}

function renderMetrics(
  devices: Map<string, DeviceState>,
  counters: Map<string, CounterState>,
  services: Map<string, PublisherRuntimePolicy["services"][number]>,
): string {
  const lines: string[] = [];
  const write = (name: PublisherMetricName, type: "gauge" | "counter", help: string): void => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
  };
  const sortedDevices = [...devices.entries()].sort(([, left], [, right]) =>
    left.device.label.localeCompare(right.device.label) ||
    left.device.publicKey.localeCompare(right.device.publicKey),
  );
  const sortedServices = [...services.values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  );

  write(
    "kepos_publisher_subscriber_connected",
    "gauge",
    "Whether the configured subscriber device currently has an active connection.",
  );
  for (const [key, state] of sortedDevices) {
    lines.push(
      sample(
        "kepos_publisher_subscriber_connected",
        deviceLabels(state.device),
        state.connected ? 1 : 0,
      ),
    );
  }

  write(
    "kepos_publisher_subscriber_last_connected_timestamp_seconds",
    "gauge",
    "Unix timestamp of the most recent successful subscriber connection.",
  );
  for (const [, state] of sortedDevices) {
    lines.push(
      sample(
        "kepos_publisher_subscriber_last_connected_timestamp_seconds",
        deviceLabels(state.device),
        state.lastConnectedSeconds,
      ),
    );
  }

  write(
    "kepos_publisher_subscriber_connection_bytes",
    "gauge",
    "Payload bytes transferred on the current subscriber connection.",
  );
  for (const [, state] of sortedDevices) {
    for (const direction of directions) {
      lines.push(
        sample(
          "kepos_publisher_subscriber_connection_bytes",
          { ...deviceLabels(state.device), direction },
          state.connectionBytes[direction],
        ),
      );
    }
  }

  write(
    "kepos_publisher_subscriber_bytes_total",
    "counter",
    "Cumulative published-service payload bytes transferred for a subscriber device.",
  );
  for (const [key, state] of sortedDevices) {
    const counter = counters.get(key) ?? emptyCounterState();
    for (const direction of directions) {
      lines.push(
        sample(
          "kepos_publisher_subscriber_bytes_total",
          { ...deviceLabels(state.device), direction },
          counter.subscriber[direction],
        ),
      );
    }
  }

  write(
    "kepos_publisher_service_authorized",
    "gauge",
    "Whether a configured subscriber device is authorized to use a published service.",
  );
  for (const [, state] of sortedDevices) {
    for (const service of sortedServices) {
      lines.push(
        sample(
          "kepos_publisher_service_authorized",
          { ...deviceLabels(state.device), service: service.id },
          service.allow === undefined || service.allow.includes(state.device.publicKey)
            ? 1
            : 0,
        ),
      );
    }
  }

  write(
    "kepos_publisher_service_active_channels",
    "gauge",
    "Number of active channels for a configured subscriber device and published service.",
  );
  for (const [, state] of sortedDevices) {
    for (const service of sortedServices) {
      lines.push(
        sample(
          "kepos_publisher_service_active_channels",
          { ...deviceLabels(state.device), service: service.id },
          state.activeChannels.get(service.id) ?? 0,
        ),
      );
    }
  }

  write(
    "kepos_publisher_service_bytes_total",
    "counter",
    "Cumulative published-service payload bytes transferred by direction.",
  );
  for (const [key, state] of sortedDevices) {
    const counter = counters.get(key) ?? emptyCounterState();
    for (const service of sortedServices) {
      const serviceCounter = counter.services.get(service.id) ?? emptyDirections();
      for (const direction of directions) {
        lines.push(
          sample(
            "kepos_publisher_service_bytes_total",
            { ...deviceLabels(state.device), service: service.id, direction },
            serviceCounter[direction],
          ),
        );
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

function deviceLabels(device: SubscriberDevice): Record<string, string> {
  return {
    subscriber_label: device.label,
    subscriber_id: device.publicKey.slice(0, 16),
  };
}

function sample(
  name: string,
  labels: Record<string, string>,
  value: number,
): string {
  const encoded = Object.entries(labels)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, field]) => `${key}="${escapeLabel(field)}"`)
    .join(",");
  return `${name}{${encoded}} ${Number.isFinite(value) ? value : 0}`;
}

function escapeLabel(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"');
}

function emptyDirections(): Record<PublisherMetricsDirection, number> {
  return {
    publisher_to_subscriber: 0,
    subscriber_to_publisher: 0,
  };
}

function emptyCounterState(): CounterState {
  return { subscriber: emptyDirections(), services: new Map() };
}

function serviceAllows(
  service: PublisherRuntimePolicy["services"][number],
  subscriberKey: string,
): boolean {
  return service.allow === undefined || service.allow.includes(subscriberKey);
}
