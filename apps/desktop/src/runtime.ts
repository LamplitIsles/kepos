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
  options.onSnapshot({
    type: "snapshot",
    phase: "starting",
    connection: "connecting",
    services: [],
  });

  const lock =
    options.subscriberLock ??
    (await dependencies.acquireSubscriberLock(options.stateDir));
  let running: RunningSubscriber;
  try {
    running = await dependencies.startSubscriber({
      stateDir: options.stateDir,
      gatewayPort: options.gatewayPort,
      services: options.services,
    });
  } catch (error) {
    await lock.release();
    options.onSnapshot({
      type: "snapshot",
      phase: "failed",
      connection: "stopped",
      services: [],
      error: errorMessage(error),
    });
    throw error;
  }

  let registry: HomeRegistry | undefined;
  let registryError: string | undefined;
  let refreshRequired = true;
  let stopped = false;
  let pollTask: Promise<void> = Promise.resolve();

  async function runPoll(): Promise<void> {
    if (stopped) return;
    const status = running.status();
    if (status.connection !== "connected") refreshRequired = true;
    if (status.connection === "connected" && refreshRequired) {
      try {
        const next = await dependencies.readRegistry(running.home.port);
        if (next.publisher.publisherKey !== running.publisherKey) {
          throw new Error("Home registry publisher does not match the connection");
        }
        registry = next;
        registryError = undefined;
        refreshRequired = false;
      } catch (error) {
        registryError = errorMessage(error);
      }
    }
    options.onSnapshot(
      createSnapshot("running", status, running.home.port, registry, registryError),
    );
  }

  await runPoll();

  return {
    poll(): Promise<void> {
      const task = pollTask.then(runPoll);
      pollTask = task.catch(() => undefined);
      return task;
    },
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      options.onSnapshot(
        createSnapshot(
          "stopping",
          running.status(),
          running.home.port,
          registry,
        ),
      );

      let failure: unknown;
      try {
        await running.stop();
      } catch (error) {
        failure = error;
      }
      try {
        await lock.release();
      } catch (error) {
        failure ??= error;
      }

      const status = running.status();
      options.onSnapshot(
        createSnapshot(
          "stopped",
          { ...status, connection: "stopped", state: "stopped" },
          running.home.port,
          registry,
        ),
      );
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
