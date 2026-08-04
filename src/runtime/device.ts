import {
  createDht,
  type DhtAddress,
  type DhtNode,
} from "../mux/hyperdht.js";
import {
  startPublisher,
  type RunningPublisher,
  type StartPublisherOptions,
} from "./publisher.js";
import {
  startSubscriber,
  type RunningSubscriber,
  type StartSubscriberOptions,
} from "./subscriber.js";

export type DevicePublisherOptions = Omit<
  StartPublisherOptions,
  "bootstrap" | "dht"
>;

export type DeviceSubscriberOptions = Omit<
  StartSubscriberOptions,
  "bootstrap" | "dht"
>;

export interface StartDeviceOptions {
  bootstrap?: DhtAddress[];
  publisher?: DevicePublisherOptions;
  subscriber?: DeviceSubscriberOptions;
}

export interface DeviceRuntimeDependencies {
  createDht: typeof createDht;
  startPublisher: typeof startPublisher;
  startSubscriber: typeof startSubscriber;
}

export interface RunningDevice {
  publisher?: RunningPublisher;
  subscriber?: RunningSubscriber;
  stop: () => Promise<void>;
}

const defaultDependencies: DeviceRuntimeDependencies = {
  createDht,
  startPublisher,
  startSubscriber,
};

export async function startDevice(
  options: StartDeviceOptions,
  dependencies: DeviceRuntimeDependencies = defaultDependencies,
): Promise<RunningDevice> {
  if (!options.publisher && !options.subscriber) {
    throw new Error("device requires at least one role");
  }
  const dht = dependencies.createDht({ bootstrap: options.bootstrap });
  const [publisherResult, subscriberResult] = await Promise.allSettled([
    options.publisher
      ? dependencies.startPublisher({ ...options.publisher, dht })
      : Promise.resolve(undefined),
    options.subscriber
      ? dependencies.startSubscriber({ ...options.subscriber, dht })
      : Promise.resolve(undefined),
  ]);
  const publisher =
    publisherResult.status === "fulfilled"
      ? publisherResult.value
      : undefined;
  const subscriber =
    subscriberResult.status === "fulfilled"
      ? subscriberResult.value
      : undefined;
  const startupError =
    publisherResult.status === "rejected"
      ? publisherResult.reason
      : subscriberResult.status === "rejected"
        ? subscriberResult.reason
        : undefined;
  if (startupError !== undefined) {
    await stopResources(publisher, subscriber, dht).catch(() => undefined);
    throw startupError;
  }

  let stopping: Promise<void> | undefined;
  return {
    publisher,
    subscriber,
    stop: () => {
      stopping ??= stopResources(publisher, subscriber, dht);
      return stopping;
    },
  };
}

async function stopResources(
  publisher: RunningPublisher | undefined,
  subscriber: RunningSubscriber | undefined,
  dht: DhtNode,
): Promise<void> {
  let firstError: unknown;
  for (const stop of [
    publisher ? () => publisher.stop() : undefined,
    subscriber ? () => subscriber.stop() : undefined,
    () => dht.destroy({ force: true }),
  ]) {
    if (!stop) continue;
    try {
      await stop();
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError !== undefined) throw firstError;
}
