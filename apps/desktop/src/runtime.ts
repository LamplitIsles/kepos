import type { HomeRegistry } from "../../../src/home/registry.js";
import { renderSVG } from "uqr";
import { derivePublisherHomeKey } from "../../../src/keys.js";
import {
  createDht,
  type DhtAddress,
  type DhtNode,
} from "../../../src/mux/hyperdht.js";
import {
  HomeRegistryTimeoutError,
  readHomeRegistry,
} from "../../../src/runtime/registry-client.js";
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
import { loadSubscriberConnectionState } from "../../../src/state/subscriber.js";
import type {
  DesktopPublisherRole,
  DesktopService,
  DesktopSnapshot,
  DesktopSubscriberRole,
} from "./protocol.js";
import { persistDesktopPublisherAllowlist } from "./config.js";
import type { DesktopSubscriberSetup } from "./options.js";

export interface StartDesktopPublisherOptions {
  stateDir: string;
  configPath?: string;
  lock?: RuntimeLock;
  policy?: PublisherRuntimePolicy;
}

export interface StartDesktopSubscriberOptions {
  stateDir: string;
  gatewayPort: number;
  gatewayHost?: StartSubscriberOptions["gatewayHost"];
  gatewayDomain?: StartSubscriberOptions["gatewayDomain"];
  services: StartSubscriberOptions["services"];
  lock?: RuntimeLock;
  route?: StartSubscriberOptions["route"];
  subscriberSetup?: DesktopSubscriberSetup;
}

export interface StartDesktopRuntimeOptions {
  bootstrap?: DhtAddress[];
  publisher?: StartDesktopPublisherOptions;
  subscriber?: StartDesktopSubscriberOptions;
  onSnapshot(snapshot: DesktopSnapshot): void;
}

export interface DesktopRuntimeConfiguration {
  bootstrap?: DhtAddress[];
  publisher?: StartDesktopPublisherOptions;
  subscriber?: StartDesktopSubscriberOptions;
}

export interface DesktopRuntimeDependencies {
  createDht: typeof createDht;
  acquirePublisherLock(stateDir: string): Promise<RuntimeLock>;
  acquireSubscriberLock(stateDir: string): Promise<RuntimeLock>;
  loadPublisherState: typeof loadPublisherState;
  loadSubscriberConnectionState: typeof loadSubscriberConnectionState;
  startPublisher(options: StartPublisherOptions): Promise<RunningPublisher>;
  startSubscriber(options: StartSubscriberOptions): Promise<RunningSubscriber>;
  readRegistry(gatewayPort: number): Promise<HomeRegistry>;
  now(): number;
  random(): number;
  renderPairingQr(uri: string): Promise<string>;
  persistPublisherAllowlist(configPath: string, allow: string[]): Promise<void>;
}

export interface RunningDesktopRuntime {
  approvePairing(): Promise<void>;
  cancelPairing(): Promise<void>;
  createPairingInvitation(): Promise<void>;
  denyPairing(): Promise<void>;
  poll(): Promise<void>;
  reconfigure(configuration: DesktopRuntimeConfiguration): Promise<void>;
  stop(): Promise<void>;
}

type RoleStartResult =
  | { ok: true }
  | { ok: false; error: unknown };

const defaultDependencies: DesktopRuntimeDependencies = {
  createDht,
  acquirePublisherLock: acquirePublisherRuntimeLock,
  acquireSubscriberLock: acquireSubscriberRuntimeLock,
  loadPublisherState,
  loadSubscriberConnectionState,
  startPublisher,
  startSubscriber,
  readRegistry: readHomeRegistry,
  now: Date.now,
  random: Math.random,
  renderPairingQr: async (uri) =>
    renderSVG(uri, {
      ecc: "M",
      border: 1,
      blackColor: "#0d1209",
      whiteColor: "#f0f1e7",
    }),
  persistPublisherAllowlist: persistDesktopPublisherAllowlist,
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
  let bootstrap = options.bootstrap;
  let dht: DhtNode | undefined;
  let appPhase: DesktopSnapshot["appPhase"] = "starting";
  let publisherRole = publisherOptions ? initialPublisherRole() : undefined;
  let subscriberRole = subscriberOptions ? initialSubscriberRole() : undefined;
  let preparedPublisherRole: DesktopPublisherRole | undefined;
  let preparedSubscriberRole: DesktopSubscriberRole | undefined;
  let publisherPreparation:
    | {
        options: StartDesktopPublisherOptions;
        result: Promise<PublisherRuntimePolicy>;
      }
    | undefined;
  let subscriberPreparation:
    | {
        options: StartDesktopSubscriberOptions;
        result: Promise<void>;
      }
    | undefined;
  let publisherLock = publisherOptions?.lock;
  let subscriberLock = subscriberOptions?.lock;
  let runningPublisher: RunningPublisher | undefined;
  let runningSubscriber: RunningSubscriber | undefined;
  let registry: HomeRegistry | undefined;
  let registryError: string | undefined;
  let refreshedGeneration: number | undefined;
  let observedGeneration: number | undefined;
  let resetIssuedGeneration: number | undefined;
  let registryRetryAttempt = 0;
  let nextRegistryAttemptAt = 0;
  let forcedResetStreak = 0;
  let nextForcedResetAt = 0;
  let stopped = false;
  let pollTask: Promise<void> | undefined;
  let reconfigureTail = Promise.resolve();
  let stopTask: Promise<void> | undefined;
  let pairingInvitation:
    | { expiresAt: number; qrSvg: string }
    | undefined;
  let pairingError: string | undefined;

  const snapshot = (): DesktopSnapshot => ({
    type: "snapshot",
    appPhase,
    ...(subscriberRole ? { subscriber: cloneSubscriberRole(subscriberRole) } : {}),
    ...(publisherRole ? { publisher: clonePublisherRole(publisherRole) } : {}),
  });
  const publish = (): void => options.onSnapshot(snapshot());

  const preparePublisherRole = (): Promise<PublisherRuntimePolicy> => {
    if (!publisherOptions || !publisherRole) {
      return Promise.reject(new Error("desktop publisher is not configured"));
    }
    if (publisherPreparation?.options === publisherOptions) {
      return publisherPreparation.result;
    }
    const currentOptions = publisherOptions;
    preparedPublisherRole = undefined;
    const result = (async (): Promise<PublisherRuntimePolicy> => {
      publisherLock ??= await dependencies.acquirePublisherLock(
        currentOptions.stateDir,
      );
      const { config, manifest } = await dependencies.loadPublisherState(
        currentOptions.stateDir,
      );
      const policy: PublisherRuntimePolicy =
        currentOptions.policy ?? {
          displayName: manifest.displayName,
          allow: config.allow,
          services: manifest.services.map(
            ({ id, name, targetPort, allow }) => ({
              id,
              name,
              targetPort,
              ...(allow === undefined ? {} : { allow }),
            }),
          ),
        };
      const publisherKey = derivePublisherHomeKey(config.seed);
      preparedPublisherRole = {
        phase: "starting",
        displayName: policy.displayName,
        publisherKey,
        keyFingerprint: publisherKey.slice(0, 16),
        activeSubscribers: 0,
        activeSubscriberKeys: [],
        acceptedConnections: 0,
        services: policy.services.map(({ id, name, targetPort }) => ({
          id,
          name,
          targetPort,
        })),
      };
      return policy;
    })();
    publisherPreparation = { options: currentOptions, result };
    return result;
  };

  const prepareSubscriberRole = (): Promise<void> => {
    if (!subscriberOptions || !subscriberRole) {
      return Promise.reject(new Error("desktop subscriber is not configured"));
    }
    if (subscriberPreparation?.options === subscriberOptions) {
      return subscriberPreparation.result;
    }
    const currentOptions = subscriberOptions;
    preparedSubscriberRole = undefined;
    const result = (async (): Promise<void> => {
      subscriberLock ??= await dependencies.acquireSubscriberLock(
        currentOptions.stateDir,
      );
      if (currentOptions.subscriberSetup?.configured === false) {
        preparedSubscriberRole = {
          ...initialSubscriberRole(),
          phase: "running",
          connection: "unconfigured",
          subscriberKey: currentOptions.subscriberSetup.publicKey,
          gatewayPort: currentOptions.gatewayPort,
          ...(currentOptions.subscriberSetup.error
            ? { error: currentOptions.subscriberSetup.error }
            : {}),
        };
        return;
      }
      const { contact, identity } =
        await dependencies.loadSubscriberConnectionState(
          currentOptions.stateDir,
        );
      preparedSubscriberRole = {
        ...initialSubscriberRole(),
        subscriberKey: identity.publicKey,
        remotePublisher: {
          displayName: contact.label,
          publisherKey: contact.publisherKey,
          keyFingerprint: contact.publisherKey.slice(0, 16),
        },
        gatewayPort: currentOptions.gatewayPort,
      };
    })();
    subscriberPreparation = { options: currentOptions, result };
    return result;
  };

  const startPublisherRole = async (): Promise<RoleStartResult> => {
    if (!publisherOptions || !publisherRole) return { ok: true };
    try {
      const policy = await preparePublisherRole();
      publisherRole = preparedPublisherRole ?? publisherRole;
      const configPath = publisherOptions.configPath;
      runningPublisher = await dependencies.startPublisher({
        stateDir: publisherOptions.stateDir,
        dht: requireDht(dht),
        ...(publisherOptions.policy ? { policy } : {}),
        ...(configPath
          ? {
              persistAllowlist: (allow) =>
                dependencies.persistPublisherAllowlist(
                  configPath,
                  allow,
                ),
            }
          : {}),
      });
      updatePublisherRole();
      return { ok: true };
    } catch (error) {
      publisherRole = {
        ...withoutActiveSubscribers(publisherRole),
        phase: "failed",
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
      await prepareSubscriberRole();
      subscriberRole = preparedSubscriberRole ?? subscriberRole;
      if (subscriberOptions.subscriberSetup?.configured === false) {
        return { ok: true };
      }
      runningSubscriber = await dependencies.startSubscriber({
        stateDir: subscriberOptions.stateDir,
        gatewayPort: subscriberOptions.gatewayPort,
        gatewayHost: subscriberOptions.gatewayHost,
        gatewayDomain: subscriberOptions.gatewayDomain,
        services: subscriberOptions.services,
        dht: requireDht(dht),
        route: subscriberOptions.route,
        waitForPublisher: false,
      });
      await updateSubscriberRole();
      return { ok: true };
    } catch (error) {
      subscriberRole = {
        ...subscriberRole,
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
    const { error: _error, pairing: _pairing, ...current } = publisherRole;
    const pairingStatus =
      status.pairing.phase === "inviting" && pairingInvitation
        ? { ...status.pairing, ...pairingInvitation }
        : status.pairing.phase === "pending" && pairingError
          ? { ...status.pairing, error: pairingError }
        : status.pairing;
    publisherRole = {
      ...current,
      phase: status.state === "stopped" ? "stopped" : "running",
      publisherKey: status.publisherKey,
      keyFingerprint: status.publisherKey.slice(0, 16),
      activeSubscribers: status.activeSubscribers,
      activeSubscriberKeys: [...status.activeSubscriberKeys],
      acceptedConnections: status.acceptedConnections,
      ...(pairingStatus.phase === "idle" ? {} : { pairing: pairingStatus }),
    };
    if (status.pairing.phase !== "inviting") pairingInvitation = undefined;
    if (status.pairing.phase !== "pending") pairingError = undefined;
  }

  async function updateSubscriberRole(): Promise<void> {
    if (!runningSubscriber || !subscriberOptions || !subscriberRole) return;
    let status = runningSubscriber.status();
    if (
      status.connection === "connected" &&
      status.connectionGeneration !== observedGeneration
    ) {
      observedGeneration = status.connectionGeneration;
      resetIssuedGeneration = undefined;
      registryError = undefined;
      registryRetryAttempt = 0;
      nextRegistryAttemptAt = 0;
    }
    if (
      status.connection === "connected" &&
      status.connectionGeneration !== refreshedGeneration &&
      dependencies.now() >= nextRegistryAttemptAt
    ) {
      const attemptGeneration = status.connectionGeneration;
      try {
        const next = await dependencies.readRegistry(
          runningSubscriber.home.port,
        );
        if (stopped) return;
        status = runningSubscriber.status();
        if (
          status.connection !== "connected" ||
          status.connectionGeneration !== attemptGeneration ||
          observedGeneration !== attemptGeneration
        ) {
          subscriberRole = createSubscriberRole(
            status,
            subscriberOptions.gatewayPort,
            registry,
            refreshedGeneration === status.connectionGeneration,
            registryError,
          );
          return;
        }
        if (next.publisher.publisherKey !== runningSubscriber.publisherKey) {
          throw new Error("Home registry publisher does not match the connection");
        }
        registry = next;
        refreshedGeneration = attemptGeneration;
        registryError = undefined;
        registryRetryAttempt = 0;
        nextRegistryAttemptAt = 0;
        forcedResetStreak = 0;
        nextForcedResetAt = 0;
      } catch (error) {
        if (stopped) return;
        status = runningSubscriber.status();
        if (
          status.connection !== "connected" ||
          status.connectionGeneration !== attemptGeneration ||
          observedGeneration !== attemptGeneration
        ) {
          subscriberRole = createSubscriberRole(
            status,
            subscriberOptions.gatewayPort,
            registry,
            refreshedGeneration === status.connectionGeneration,
            registryError,
          );
          return;
        }
        registryError = errorMessage(error);
        scheduleRegistryRetry();
        if (
          error instanceof HomeRegistryTimeoutError &&
          resetIssuedGeneration !== attemptGeneration &&
          dependencies.now() >= nextForcedResetAt
        ) {
          resetIssuedGeneration = attemptGeneration;
          forcedResetStreak++;
          nextForcedResetAt = dependencies.now() + jitteredDelay(
            forcedResetDelay(forcedResetStreak),
            dependencies.random(),
          );
          runningSubscriber.invalidateConnection(
            attemptGeneration,
            "home.registry.timeout",
          );
          status = runningSubscriber.status();
        }
      }
    }
    if (stopped) return;
    subscriberRole = createSubscriberRole(
      status,
      subscriberOptions.gatewayPort,
      registry,
      refreshedGeneration === status.connectionGeneration,
      registryError,
    );
  }

  function scheduleRegistryRetry(): void {
    const delay = registryRetryDelay(registryRetryAttempt);
    registryRetryAttempt++;
    nextRegistryAttemptAt = dependencies.now() + jitteredDelay(
      delay,
      dependencies.random(),
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

  async function cleanupDht(): Promise<unknown> {
    const current = dht;
    try {
      await current?.destroy({ force: true });
      if (dht === current) dht = undefined;
      return undefined;
    } catch (error) {
      return error;
    }
  }

  function markTransportFailure(
    configuration: DesktopRuntimeConfiguration,
    error: unknown,
  ): void {
    const message = errorMessage(error);
    publisherRole = configuration.publisher
      ? {
          ...withoutActiveSubscribers(
            preparedPublisherRole ??
              publisherRole ??
              initialPublisherRole(),
          ),
          phase: "failed",
          acceptedConnections: 0,
          error: message,
        }
      : undefined;
    subscriberRole = configuration.subscriber
      ? {
          ...(preparedSubscriberRole ??
            subscriberRole ??
            initialSubscriberRole()),
          phase: "failed",
          connection: "stopped",
          error: message,
        }
      : undefined;
  }

  async function applyConfiguration(
    configuration: DesktopRuntimeConfiguration,
  ): Promise<void> {
    if (stopped) throw new Error("desktop runtime is stopped");
    const transportChanged =
      dht === undefined ||
      !sameTransportConfiguration(bootstrap, configuration.bootstrap);
    const publisherChanged = transportChanged || !sameRoleConfiguration(
      publisherOptions,
      configuration.publisher,
    );
    const subscriberChanged = transportChanged || !sameRoleConfiguration(
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
          ...withoutActiveSubscribers(publisherRole),
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
      preparedPublisherRole = undefined;
      publisherPreparation = undefined;
    }
    if (subscriberChanged) {
      subscriberOptions = configuration.subscriber;
      subscriberLock = configuration.subscriber?.lock;
      subscriberRole = configuration.subscriber ? initialSubscriberRole() : undefined;
      preparedSubscriberRole = undefined;
      subscriberPreparation = undefined;
      registry = undefined;
      registryError = undefined;
      refreshedGeneration = undefined;
      observedGeneration = undefined;
      resetIssuedGeneration = undefined;
      registryRetryAttempt = 0;
      nextRegistryAttemptAt = 0;
      forcedResetStreak = 0;
      nextForcedResetAt = 0;
    }
    await Promise.allSettled([
      publisherChanged && publisherOptions
        ? preparePublisherRole()
        : undefined,
      subscriberChanged && subscriberOptions
        ? prepareSubscriberRole()
        : undefined,
    ]);

    if (transportChanged) {
      const dhtFailure = await cleanupDht();
      if (dhtFailure !== undefined) {
        markTransportFailure(configuration, dhtFailure);
        publish();
        throw dhtFailure;
      }
      try {
        dht = dependencies.createDht({
          bootstrap: configuration.bootstrap,
        });
        bootstrap = configuration.bootstrap;
      } catch (error) {
        markTransportFailure(configuration, error);
        publish();
        throw error;
      }
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

  await Promise.allSettled([
    publisherOptions ? preparePublisherRole() : undefined,
    subscriberOptions ? prepareSubscriberRole() : undefined,
  ]);

  try {
    dht = dependencies.createDht({ bootstrap });
  } catch (error) {
    appPhase = "running";
    markTransportFailure(
      { bootstrap, publisher: publisherOptions, subscriber: subscriberOptions },
      error,
    );
    try {
      publish();
    } catch {
      // Preserve the transport failure after attempting the visible snapshot.
    }
    await cleanupRoles();
    throw error;
  }

  try {
    publish();
    await Promise.allSettled([startPublisherRole(), startSubscriberRole()]);
    appPhase = "running";
    publish();
  } catch (error) {
    await cleanupRoles();
    await cleanupDht();
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
    async approvePairing(): Promise<void> {
      if (!runningPublisher) throw new Error("Publisher is not running");
      pairingError = undefined;
      try {
        await runningPublisher.approvePairing();
      } catch (error) {
        pairingError = error instanceof Error ? error.message : String(error);
        updatePublisherRole();
        publish();
        throw error;
      }
      updatePublisherRole();
      publish();
    },
    async cancelPairing(): Promise<void> {
      if (!runningPublisher) throw new Error("Publisher is not running");
      runningPublisher.cancelPairing();
      pairingInvitation = undefined;
      pairingError = undefined;
      updatePublisherRole();
      publish();
    },
    async createPairingInvitation(): Promise<void> {
      if (!runningPublisher) throw new Error("Publisher is not running");
      pairingError = undefined;
      const invitation = runningPublisher.createPairingInvitation();
      try {
        pairingInvitation = {
          expiresAt: invitation.expiresAt,
          qrSvg: await dependencies.renderPairingQr(invitation.uri),
        };
      } catch (error) {
        runningPublisher.cancelPairing();
        throw error;
      }
      updatePublisherRole();
      publish();
    },
    async denyPairing(): Promise<void> {
      if (!runningPublisher) throw new Error("Publisher is not running");
      runningPublisher.denyPairing();
      pairingInvitation = undefined;
      pairingError = undefined;
      updatePublisherRole();
      publish();
    },
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
        const dhtFailure = await cleanupDht();
        failure ??= dhtFailure;
        appPhase = "stopped";
        if (publisherRole) {
          publisherRole = {
            ...withoutActiveSubscribers(publisherRole),
            phase: "stopped",
          };
        }
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

function sameTransportConfiguration(
  left: DhtAddress[] | undefined,
  right: DhtAddress[] | undefined,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function requireDht(dht: DhtNode | undefined): DhtNode {
  if (!dht) throw new Error("desktop HyperDHT node is unavailable");
  return dht;
}

function initialPublisherRole(): DesktopPublisherRole {
  return {
    phase: "starting",
    activeSubscribers: 0,
    activeSubscriberKeys: [],
    acceptedConnections: 0,
    services: [],
  };
}

function withoutActiveSubscribers(
  role: DesktopPublisherRole,
): DesktopPublisherRole {
  return {
    ...role,
    activeSubscribers: 0,
    activeSubscriberKeys: [],
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
  registryCurrent = false,
  error?: string,
): DesktopSubscriberRole {
  const servicesAvailable =
    status.connection === "connected" && registryCurrent;
  const services = registry
    ? createServices(registry, status, gatewayPort, servicesAvailable)
    : [];
  return {
    phase: status.state === "stopped" ? "stopped" : "running",
    connection: status.connection,
    subscriberKey: status.subscriberKey,
    remotePublisher: {
      displayName: registry?.publisher.displayName ?? status.publisherLabel,
      publisherKey: status.publisherKey,
      keyFingerprint: status.publisherKey.slice(0, 16),
    },
    gatewayPort,
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

function registryRetryDelay(attempt: number): number {
  const delays = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];
  return delays[Math.min(attempt, delays.length - 1)]!;
}

function forcedResetDelay(streak: number): number {
  if (streak === 1) return 30_000;
  if (streak === 2) return 120_000;
  return 300_000;
}

function jitteredDelay(delayMs: number, random: number): number {
  const bounded = Math.min(1, Math.max(0, random));
  return Math.round(delayMs * (0.9 + bounded * 0.2));
}

function clonePublisherRole(role: DesktopPublisherRole): DesktopPublisherRole {
  return {
    ...role,
    activeSubscriberKeys: [...role.activeSubscriberKeys],
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
