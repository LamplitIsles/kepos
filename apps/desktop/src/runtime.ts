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
  bootstrap?: StartPublisherOptions["bootstrap"];
  policy?: PublisherRuntimePolicy;
}

export interface StartDesktopSubscriberOptions {
  stateDir: string;
  gatewayPort: number;
  gatewayHost?: StartSubscriberOptions["gatewayHost"];
  gatewayDomain?: StartSubscriberOptions["gatewayDomain"];
  services: StartSubscriberOptions["services"];
  lock?: RuntimeLock;
  bootstrap?: StartSubscriberOptions["bootstrap"];
  route?: StartSubscriberOptions["route"];
}

export interface StartDesktopRuntimeOptions {
  publisher?: StartDesktopPublisherOptions;
  subscriber?: StartDesktopSubscriberOptions;
  onSnapshot(snapshot: DesktopSnapshot): void;
}

export interface DesktopRuntimeConfiguration {
  publisher?: StartDesktopPublisherOptions;
  subscriber?: StartDesktopSubscriberOptions;
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
  reconfigure(configuration: DesktopRuntimeConfiguration): Promise<void>;
  stop(): Promise<void>;
}

type RoleStartResult =
  | { ok: true }
  | { ok: false; error: unknown };

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

  let publisherOptions = options.publisher;
  let subscriberOptions = options.subscriber;
  let appPhase: DesktopSnapshot["appPhase"] = "starting";
  let publisherRole = publisherOptions ? initialPublisherRole() : undefined;
  let subscriberRole = subscriberOptions ? initialSubscriberRole() : undefined;
  let publisherLock = publisherOptions?.lock;
  let subscriberLock = subscriberOptions?.lock;
  let runningPublisher: RunningPublisher | undefined;
  let runningSubscriber: RunningSubscriber | undefined;
  let registry: HomeRegistry | undefined;
  let refreshedGeneration: number | undefined;
  let stopped = false;
  let pollTask: Promise<void> | undefined;
  let reconfigureTail = Promise.resolve();
  let stopTask: Promise<void> | undefined;

  const snapshot = (): DesktopSnapshot => ({
    type: "snapshot",
    appPhase,
    ...(subscriberRole ? { subscriber: cloneSubscriberRole(subscriberRole) } : {}),
    ...(publisherRole ? { publisher: clonePublisherRole(publisherRole) } : {}),
  });
  const publish = (): void => options.onSnapshot(snapshot());

  const startPublisherRole = async (): Promise<RoleStartResult> => {
    if (!publisherOptions || !publisherRole) return { ok: true };
    try {
      publisherLock ??= await dependencies.acquirePublisherLock(
        publisherOptions.stateDir,
      );
      const { config, manifest } = await dependencies.loadPublisherState(
        publisherOptions.stateDir,
      );
      const policy: PublisherRuntimePolicy =
        publisherOptions.policy ?? {
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
        stateDir: publisherOptions.stateDir,
        bootstrap: publisherOptions.bootstrap,
        policy,
      });
      updatePublisherRole();
      return { ok: true };
    } catch (error) {
      publisherRole = {
        ...publisherRole,
        phase: "failed",
        activeSubscribers: 0,
        acceptedConnections: 0,
        error: errorMessage(error),
      };
      await cleanupPublisherRole();
      return { ok: false, error };
    }
  };

  const startSubscriberRole = async (): Promise<RoleStartResult> => {
    if (!subscriberOptions || !subscriberRole) return { ok: true };
    try {
      subscriberLock ??= await dependencies.acquireSubscriberLock(
        subscriberOptions.stateDir,
      );
      runningSubscriber = await dependencies.startSubscriber({
        stateDir: subscriberOptions.stateDir,
        gatewayPort: subscriberOptions.gatewayPort,
        gatewayHost: subscriberOptions.gatewayHost,
        gatewayDomain: subscriberOptions.gatewayDomain,
        services: subscriberOptions.services,
        bootstrap: subscriberOptions.bootstrap,
        route: subscriberOptions.route,
        waitForPublisher: false,
      });
      await updateSubscriberRole();
      return { ok: true };
    } catch (error) {
      subscriberRole = {
        phase: "failed",
        connection: "stopped",
        services: [],
        error: errorMessage(error),
      };
      await cleanupSubscriberRole();
      return { ok: false, error };
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
    if (!runningSubscriber || !subscriberOptions || !subscriberRole) return;
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
      subscriberOptions.gatewayPort,
      registry,
      registryError,
    );
  }

  async function releaseLock(role: "publisher" | "subscriber"): Promise<void> {
    if (role === "publisher") {
      const lock = publisherLock;
      await lock?.release();
      if (publisherLock === lock) publisherLock = undefined;
      return;
    }
    const lock = subscriberLock;
    await lock?.release();
    if (subscriberLock === lock) subscriberLock = undefined;
  }

  async function cleanupPublisherRole(): Promise<unknown> {
    let failure: unknown;
    try {
      await runningPublisher?.stop();
    } catch (error) {
      failure = error;
    }
    runningPublisher = undefined;
    try {
      await releaseLock("publisher");
    } catch (error) {
      failure ??= error;
    }
    return failure;
  }

  async function cleanupSubscriberRole(): Promise<unknown> {
    let failure: unknown;
    try {
      await runningSubscriber?.stop();
    } catch (error) {
      failure = error;
    }
    runningSubscriber = undefined;
    try {
      await releaseLock("subscriber");
    } catch (error) {
      failure ??= error;
    }
    return failure;
  }

  async function cleanupRoles(): Promise<unknown> {
    let failure: unknown;
    for (const cleanup of [cleanupPublisherRole, cleanupSubscriberRole]) {
      try {
        const cleanupFailure = await cleanup();
        failure ??= cleanupFailure;
      } catch (error) {
        failure ??= error;
      }
    }
    return failure;
  }

  async function applyConfiguration(
    configuration: DesktopRuntimeConfiguration,
  ): Promise<void> {
    if (stopped) throw new Error("desktop runtime is stopped");
    const publisherChanged = !sameRoleConfiguration(
      publisherOptions,
      configuration.publisher,
    );
    const subscriberChanged = !sameRoleConfiguration(
      subscriberOptions,
      configuration.subscriber,
    );
    if (!publisherChanged && !subscriberChanged) return;

    await pollTask;
    if (publisherChanged && publisherRole?.phase === "running") {
      publisherRole = { ...publisherRole, phase: "stopping" };
    }
    if (subscriberChanged && subscriberRole?.phase === "running") {
      subscriberRole = { ...subscriberRole, phase: "stopping" };
    }
    publish();

    let failure: unknown;
    if (publisherChanged) {
      const publisherFailure = await cleanupPublisherRole();
      failure ??= publisherFailure;
    }
    if (subscriberChanged) {
      const subscriberFailure = await cleanupSubscriberRole();
      failure ??= subscriberFailure;
    }
    if (failure !== undefined) {
      if (publisherChanged && publisherRole) {
        publisherRole = {
          ...publisherRole,
          phase: "failed",
          error: errorMessage(failure),
        };
      }
      if (subscriberChanged && subscriberRole) {
        subscriberRole = {
          ...subscriberRole,
          phase: "failed",
          connection: "stopped",
          error: errorMessage(failure),
        };
      }
      publish();
      throw failure;
    }

    if (publisherChanged) {
      publisherOptions = configuration.publisher;
      publisherLock = configuration.publisher?.lock;
      publisherRole = configuration.publisher ? initialPublisherRole() : undefined;
    }
    if (subscriberChanged) {
      subscriberOptions = configuration.subscriber;
      subscriberLock = configuration.subscriber?.lock;
      subscriberRole = configuration.subscriber ? initialSubscriberRole() : undefined;
      registry = undefined;
      refreshedGeneration = undefined;
    }
    if (stopped) return;
    publish();
    const startResults = await Promise.all([
      publisherChanged ? startPublisherRole() : undefined,
      subscriberChanged ? startSubscriberRole() : undefined,
    ]);
    if (!stopped) publish();
    const failedStart = startResults.find(
      (result): result is Extract<RoleStartResult, { ok: false }> =>
        result !== undefined && !result.ok,
    );
    if (failedStart) throw failedStart.error;
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
    reconfigure(configuration): Promise<void> {
      const task = reconfigureTail.then(() => applyConfiguration(configuration));
      reconfigureTail = task.catch(() => undefined);
      return task;
    },
    stop(): Promise<void> {
      stopTask ??= (async () => {
        if (stopped) return;
        stopped = true;
        appPhase = "stopping";
        await reconfigureTail;
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

function sameRoleConfiguration(
  left: { lock?: RuntimeLock } | undefined,
  right: { lock?: RuntimeLock } | undefined,
): boolean {
  if (!left || !right) return left === right;
  const { lock: _leftLock, ...leftConfiguration } = left;
  const { lock: _rightLock, ...rightConfiguration } = right;
  return JSON.stringify(leftConfiguration) === JSON.stringify(rightConfiguration);
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
