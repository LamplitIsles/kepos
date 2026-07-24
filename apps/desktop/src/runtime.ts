import type { HomeRegistry } from "../../../src/home/registry.js";
import { readHomeRegistry } from "../../../src/runtime/registry-client.js";
import { createServicePresentations } from "../../../src/runtime/service-handlers.js";
import {
  acquireSubscriberRuntimeLock,
  type SubscriberRuntimeLock,
} from "../../../src/runtime/subscriber-lock.js";
import {
  startSubscriber,
  type RunningSubscriber,
  type StartSubscriberOptions,
  type SubscriberRuntimeStatus,
} from "../../../src/runtime/subscriber.js";
import type { DesktopSnapshot, DesktopService } from "./protocol.js";

export interface StartDesktopRuntimeOptions {
  stateDir: string;
  gatewayPort: number;
  services: StartSubscriberOptions["services"];
  onSnapshot(snapshot: DesktopSnapshot): void;
  subscriberLock?: SubscriberRuntimeLock;
}

export interface DesktopRuntimeDependencies {
  acquireSubscriberLock(stateDir: string): Promise<SubscriberRuntimeLock>;
  startSubscriber(options: StartSubscriberOptions): Promise<RunningSubscriber>;
  readRegistry(gatewayPort: number): Promise<HomeRegistry>;
}

export interface RunningDesktopRuntime {
  poll(): Promise<void>;
  stop(): Promise<void>;
}

const defaultDependencies: DesktopRuntimeDependencies = {
  acquireSubscriberLock: acquireSubscriberRuntimeLock,
  startSubscriber,
  readRegistry: readHomeRegistry,
};

export async function startDesktopRuntime(
  options: StartDesktopRuntimeOptions,
  dependencies: DesktopRuntimeDependencies = defaultDependencies,
): Promise<RunningDesktopRuntime> {
  const lock =
    options.subscriberLock ??
    (await dependencies.acquireSubscriberLock(options.stateDir));
  let running: RunningSubscriber;

  const cleanFailedStart = async (
    error: unknown,
    started?: RunningSubscriber,
  ): Promise<void> => {
    try {
      await started?.stop();
    } catch {
      // Keep the original startup error, but never release identity early.
    }
    try {
      await lock.release();
    } catch {
      // Keep the original startup error after attempting ordered cleanup.
    }
    try {
      options.onSnapshot({
        type: "snapshot",
        phase: "failed",
        connection: "stopped",
        services: [],
        error: errorMessage(error),
      });
    } catch {
      // The original startup failure is more useful than a failed UI update.
    }
  };

  try {
    options.onSnapshot({
      type: "snapshot",
      phase: "starting",
      connection: "connecting",
      services: [],
    });
    running = await dependencies.startSubscriber({
      stateDir: options.stateDir,
      gatewayPort: options.gatewayPort,
      services: options.services,
      waitForPublisher: false,
    });
  } catch (error) {
    await cleanFailedStart(error);
    throw error;
  }

  let registry: HomeRegistry | undefined;
  let registryError: string | undefined;
  let refreshedGeneration: number | undefined;
  let stopped = false;
  let pollTask: Promise<void> = Promise.resolve();

  async function runPoll(): Promise<void> {
    if (stopped) return;
    const status = running.status();
    if (
      status.connection === "connected" &&
      status.connectionGeneration !== refreshedGeneration
    ) {
      try {
        const next = await dependencies.readRegistry(running.home.port);
        if (stopped) return;
        if (next.publisher.publisherKey !== running.publisherKey) {
          throw new Error("Home registry publisher does not match the connection");
        }
        registry = next;
        registryError = undefined;
        refreshedGeneration = status.connectionGeneration;
      } catch (error) {
        if (stopped) return;
        registryError = errorMessage(error);
      }
    }
    if (stopped) return;
    options.onSnapshot(
      createSnapshot("running", status, running.home.port, registry, registryError),
    );
  }

  try {
    await runPoll();
  } catch (error) {
    await cleanFailedStart(error, running);
    throw error;
  }

  return {
    poll(): Promise<void> {
      const task = pollTask.then(runPoll);
      pollTask = task.catch(() => undefined);
      return task;
    },
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      let failure: unknown;
      const cleanup = async (step: () => void | Promise<void>): Promise<void> => {
        try {
          await step();
        } catch (error) {
          failure ??= error;
        }
      };

      await cleanup(() => options.onSnapshot(
        createSnapshot(
          "stopping",
          running.status(),
          running.home.port,
          registry,
        ),
      ));
      await cleanup(() => running.stop());
      await cleanup(() => lock.release());

      const status = running.status();
      await cleanup(() => options.onSnapshot(
        createSnapshot(
          "stopped",
          { ...status, connection: "stopped", state: "stopped" },
          running.home.port,
          registry,
        ),
      ));
      if (failure !== undefined) throw failure;
    },
  };
}

function createSnapshot(
  phase: DesktopSnapshot["phase"],
  status: SubscriberRuntimeStatus,
  gatewayPort: number,
  registry?: HomeRegistry,
  error?: string,
): DesktopSnapshot {
  const connected = status.connection === "connected" && phase === "running";
  const services = registry
    ? createServices(registry, status, gatewayPort, connected)
    : [];
  return {
    type: "snapshot",
    phase,
    connection: status.connection,
    ...(registry
      ? {
          publisher: {
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
