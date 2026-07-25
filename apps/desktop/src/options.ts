import path from "node:path";

import type { SubscriberService } from "../../../src/runtime/subscriber.js";

export interface DesktopSubscriberOptions {
  stateDir: string;
  gatewayPort: number;
  services: SubscriberService[];
}

export interface DesktopPublisherOptions {
  stateDir: string;
}

export interface DesktopOptions {
  subscriber?: DesktopSubscriberOptions;
  publisher?: DesktopPublisherOptions;
}

export function parseDesktopOptions(arguments_: readonly string[]): DesktopOptions {
  let subscriberStateDir: string | undefined;
  let publisherStateDir: string | undefined;
  const services: SubscriberService[] = [];

  for (let index = 0; index < arguments_.length; index += 1) {
    const option = arguments_[index];
    const value = arguments_[index + 1];
    if (
      option !== "--subscriber-state" &&
      option !== "--publisher-state" &&
      option !== "--subscriber-service"
    ) {
      throw new Error(`unknown option: ${option}`);
    }
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${option} requires a value`);
    }
    index += 1;

    if (option === "--subscriber-state") {
      if (subscriberStateDir !== undefined) {
        throw new Error("--subscriber-state may be set only once");
      }
      subscriberStateDir = path.resolve(value);
      continue;
    }
    if (option === "--publisher-state") {
      if (publisherStateDir !== undefined) {
        throw new Error("--publisher-state may be set only once");
      }
      publisherStateDir = path.resolve(value);
      continue;
    }
    services.push(parseService(value));
  }

  if (subscriberStateDir === undefined && publisherStateDir === undefined) {
    throw new Error("desktop requires at least one role");
  }
  if (subscriberStateDir === undefined && services.length > 0) {
    throw new Error("subscriber service requires --subscriber-state");
  }
  if (new Set(services.map(({ id }) => id)).size !== services.length) {
    throw new Error("desktop subscriber services must have unique ids");
  }

  return {
    ...(publisherStateDir
      ? { publisher: { stateDir: publisherStateDir } }
      : {}),
    ...(subscriberStateDir
      ? {
          subscriber: {
            stateDir: subscriberStateDir,
            gatewayPort: 17_480,
            services,
          },
        }
      : {}),
  };
}

function parseService(value: string): SubscriberService {
  const separator = value.lastIndexOf(":");
  const id = value.slice(0, separator);
  const localPort = Number(value.slice(separator + 1));
  if (!/^[a-z][a-z0-9-]*$/.test(id)) {
    throw new Error("desktop subscriber service id is invalid");
  }
  if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65_535) {
    throw new Error(
      "desktop subscriber service port must be an integer from 1 through 65535",
    );
  }
  return { id, localPort };
}
