import type { HomeRegistry } from "../../../src/home/registry.js";
import { derivePublisherHomeKey } from "../../../src/keys.js";
import { readHomeRegistry } from "../../../src/runtime/registry-client.js";
import { createServicePresentations } from "../../../src/runtime/service-handlers.js";
import {
  acquirePublisherRuntimeLock,
  acquireSubscriberRuntimeLock,
  type RuntimeLock,
} from "../../../src/runtime/runtime-lock.js";
import {
  startPublisher,
  type PublisherRuntimePolicy,
  type RunningPublisher,
  type StartPublisherOptions,
} from "../../../src/runtime/publisher.js";
import {
  startSubscriber,
  type RunningSubscriber,
  type StartSubscriberOptions,
  type SubscriberRuntimeStatus,
} from "../../../src/runtime/subscriber.js";
import { loadPublisherState } from "../../../src/state/publisher.js";
import type {
  DesktopPublisherRole,
  DesktopService,
  DesktopSnapshot,
  DesktopSubscriberRole,
} from "./protocol.js";

export interface StartDesktopPublisherOptions {
  stateDir: string;
  lock?: RuntimeLock;
}

export interface StartDesktopSubscriberOptions {
  stateDir: string;
  gatewayPort: number;
  services: StartSubscriberOptions["services"];
  lock?: RuntimeLock;
}

export interface StartDesktopRuntimeOptions {
  publisher?: StartDesktopPublisherOptions;
  subscriber?: StartDesktopSubscriberOptions;
  onSnapshot(snapshot: DesktopSnapshot): void;
}

export interface DesktopRuntimeDependencies {
  acquirePublisherLock(stateDir: string): Promise<RuntimeLock>;
  acquireSubscriberLock(stateDir: string): Promise<RuntimeLock>;
  loadPublisherState: typeof loadPublisherState;
  startPublisher(options: StartPublisherOptions): Promise<RunningPublisher>;
  startSubscriber(options: StartSubscriberOptions): Promise<RunningSubscriber>;
  readRegistry(gatewayPort: number): Promise<HomeRegistry>;
}

export interface RunningDesktopRuntime {
  poll(): Promise<void>;
  stop(): Promise<void>;
}

const defaultDependencies: DesktopRuntimeDependencies = {
  acquirePublisherLock: acquirePublisherRuntimeLock,
  acquireSubscriberLock: acquireSubscriberRuntimeLock,
  loadPublisherState,
  startPublisher,
  startSubscriber,
  readRegistry: readHomeRegistry,
};

export async function startDesktopRuntime(
  options: StartDesktopRuntimeOptions,
  dependencies: DesktopRuntimeDependencies = defaultDependencies,
): Promise<RunningDesktopRuntime> {
  if (!options.publisher && !options.subscriber) {
    throw new Error("desktop runtime requires at least one role");
  }

  let appPhase: DesktopSnapshot["appPhase"] = "starting";
  let publisherRole = options.publisher ? initialPublisherRole() : undefined;
  let subscriberRole = options.subscriber ? initialSubscriberRole() : undefined;
  let publisherLock = options.publisher?.lock;
  let subscriberLock = options.subscriber?.lock;
  let runningPublisher: RunningPublisher | undefined;
  let runningSubscriber: RunningSubscriber | undefined;
  let registry: HomeRegistry | undefined;
  let refreshedGeneration: number | undefined;
  let stopped = false;
  let pollTask: Promise<void> | undefined;
  let stopTask: Promise<void> | undefined;

  const snapshot = (): DesktopSnapshot => ({
    type: "snapshot",
    appPhase,
    ...(subscriberRole ? { subscriber: cloneSubscriberRole(subscriberRole) } : {}),
    ...(publisherRole ? { publisher: clonePublisherRole(publisherRole) } : {}),
  });
  const publish = (): void => options.onSnapshot(snapshot());

  const startPublisherRole = async (): Promise<void> => {
    if (!options.publisher || !publisherRole) return;
    try {
      publisherLock ??= await dependencies.acquirePublisherLock(
        options.publisher.stateDir,
      );
      const { config, manifest } = await dependencies.loadPublisherState(
        options.publisher.stateDir,
      );
      const policy: PublisherRuntimePolicy = {
        displayName: manifest.displayName,
        allow: config.allow,
        services: manifest.services.map(({ id, name, targetPort }) => ({
          id,
          name,
          targetPort,
        })),
      };
      const publisherKey = derivePublisherHomeKey(config.seed);
      publisherRole = {
        phase: "starting",
        displayName: policy.displayName,
        publisherKey,
        keyFingerprint: publisherKey.slice(0, 16),
        activeSubscribers: 0,
        acceptedConnections: 0,
        services: policy.services.map(({ id, name, targetPort }) => ({
          id,
          name,
          targetPort,
        })),
      };
      runningPublisher = await dependencies.startPublisher({
        stateDir: options.publisher.stateDir,
        policy,
      });
      updatePublisherRole();
    } catch (error) {
      publisherRole = {
        ...publisherRole,
        phase: "failed",
        activeSubscribers: 0,
        acceptedConnections: 0,
        error: errorMessage(error),
      };
      await releaseLock("publisher");
    }
  };

  const startSubscriberRole = async (): Promise<void> => {
    if (!options.subscriber || !subscriberRole) return;
    try {
      subscriberLock ??= await dependencies.acquireSubscriberLock(
        options.subscriber.stateDir,
      );
      runningSubscriber = await dependencies.startSubscriber({
        stateDir: options.subscriber.stateDir,
        gatewayPort: options.subscriber.gatewayPort,
        services: options.subscriber.services,
        waitForPublisher: false,
      });
      await updateSubscriberRole();
    } catch (error) {
      subscriberRole = {
        phase: "failed",
        connection: "stopped",
        services: [],
        error: errorMessage(error),
      };
      await releaseLock("subscriber");
    }
  };

  function updatePublisherRole(): void {
    if (!runningPublisher || !publisherRole) return;
    const status = runningPublisher.status();
    const { error: _error, ...current } = publisherRole;
    publisherRole = {
      ...current,
      phase: status.state === "stopped" ? "stopped" : "running",
      publisherKey: status.publisherKey,
      keyFingerprint: status.publisherKey.slice(0, 16),
      activeSubscribers: status.activeSubscribers,
      acceptedConnections: status.acceptedConnections,
    };
  }

  async function updateSubscriberRole(): Promise<void> {
    if (!runningSubscriber || !options.subscriber || !subscriberRole) return;
    const status = runningSubscriber.status();
    let registryError: string | undefined;
    if (
      status.connection === "connected" &&
      status.connectionGeneration !== refreshedGeneration
    ) {
      try {
        const next = await dependencies.readRegistry(runningSubscriber.home.port);
        if (stopped) return;
        if (next.publisher.publisherKey !== runningSubscriber.publisherKey) {
          throw new Error("Home registry publisher does not match the connection");
        }
        registry = next;
        refreshedGeneration = status.connectionGeneration;
      } catch (error) {
        if (stopped) return;
        registryError = errorMessage(error);
      }
    }
    if (stopped) return;
    subscriberRole = createSubscriberRole(
      status,
      options.subscriber.gatewayPort,
      registry,
      registryError,
    );
  }

  async function releaseLock(role: "publisher" | "subscriber"): Promise<void> {
    if (role === "publisher") {
      const lock = publisherLock;
      publisherLock = undefined;
      await lock?.release();
      return;
    }
    const lock = subscriberLock;
    subscriberLock = undefined;
    await lock?.release();
  }

  async function cleanupRoles(): Promise<unknown> {
    let failure: unknown;
    const cleanup = async (step: () => void | Promise<void>): Promise<void> => {
      try {
        await step();
      } catch (error) {
        failure ??= error;
      }
    };

    await cleanup(() => runningPublisher?.stop());
    runningPublisher = undefined;
    await cleanup(() => releaseLock("publisher"));
    await cleanup(() => runningSubscriber?.stop());
    runningSubscriber = undefined;
    await cleanup(() => releaseLock("subscriber"));
    return failure;
  }

  try {
    publish();
    await Promise.allSettled([startPublisherRole(), startSubscriberRole()]);
    appPhase = "running";
    publish();
  } catch (error) {
    await cleanupRoles();
    throw error;
  }

  function runPoll(): Promise<void> {
    return (async () => {
      if (stopped) return;
      updatePublisherRole();
      await updateSubscriberRole();
      if (stopped) return;
      publish();
    })();
  }

  return {
    poll(): Promise<void> {
      if (pollTask !== undefined) return pollTask;
      const task = runPoll().finally(() => {
        if (pollTask === task) pollTask = undefined;
      });
      pollTask = task;
      return task;
    },
    stop(): Promise<void> {
      stopTask ??= (async () => {
        if (stopped) return;
        stopped = true;
        appPhase = "stopping";
        if (publisherRole?.phase === "running") {
          publisherRole = { ...publisherRole, phase: "stopping" };
        }
        if (subscriberRole?.phase === "running") {
          subscriberRole = { ...subscriberRole, phase: "stopping" };
        }
        let failure: unknown;
        try {
          publish();
        } catch (error) {
          failure = error;
        }
        const cleanupFailure = await cleanupRoles();
        failure ??= cleanupFailure;
        appPhase = "stopped";
        if (publisherRole) publisherRole = { ...publisherRole, phase: "stopped" };
        if (subscriberRole) {
          subscriberRole = {
            ...subscriberRole,
            phase: "stopped",
            connection: "stopped",
            services: subscriberRole.services.map((service) => ({
              ...service,
              available: false,
            })),
          };
        }
        try {
          publish();
        } catch (error) {
          failure ??= error;
        }
        if (failure !== undefined) throw failure;
      })();
      return stopTask;
    },
  };
}

function initialPublisherRole(): DesktopPublisherRole {
  return {
    phase: "starting",
    activeSubscribers: 0,
    acceptedConnections: 0,
    services: [],
  };
}

function initialSubscriberRole(): DesktopSubscriberRole {
  return {
    phase: "starting",
    connection: "connecting",
    services: [],
  };
}

function createSubscriberRole(
  status: SubscriberRuntimeStatus,
  gatewayPort: number,
  registry?: HomeRegistry,
  error?: string,
): DesktopSubscriberRole {
  const connected = status.connection === "connected";
  const services = registry
    ? createServices(registry, status, gatewayPort, connected)
    : [];
  return {
    phase: status.state === "stopped" ? "stopped" : "running",
    connection: status.connection,
    ...(registry
      ? {
          remotePublisher: {
            displayName: registry.publisher.displayName,
            keyFingerprint: status.publisherKey.slice(0, 16),
          },
          gatewayPort,
        }
      : {}),
    services,
    ...(error ? { error } : {}),
  };
}

function createServices(
  registry: HomeRegistry,
  status: SubscriberRuntimeStatus,
  gatewayPort: number,
  connected: boolean,
): DesktopService[] {
  const localPorts = new Map(
    status.services.map(({ id, port }) => [id, port] as const),
  );
  return createServicePresentations(
    registry.services,
    gatewayPort,
    localPorts,
  ).map((service) => ({ ...service, available: connected }));
}

function clonePublisherRole(role: DesktopPublisherRole): DesktopPublisherRole {
  return {
    ...role,
    services: role.services.map((service) => ({ ...service })),
  };
}

function cloneSubscriberRole(role: DesktopSubscriberRole): DesktopSubscriberRole {
  return {
    ...role,
    services: role.services.map((service) => ({ ...service })),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
