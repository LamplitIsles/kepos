import path from "node:path";

import {
  loadKeposConfig,
  type KeposConfig,
} from "../../../src/app-config.js";
import type { DhtAddress } from "../../../src/mux/hyperdht.js";
import type { Route } from "../../../src/mux/route.js";
import type { PublisherRuntimePolicy } from "../../../src/runtime/publisher.js";
import type { SubscriberService } from "../../../src/runtime/subscriber.js";

export interface DesktopSubscriberOptions {
  stateDir: string;
  gatewayPort: number;
  gatewayHost?: string;
  gatewayDomain?: string;
  bootstrap?: DhtAddress[];
  route?: Route;
  services: SubscriberService[];
}

export interface DesktopPublisherOptions {
  stateDir: string;
  bootstrap?: DhtAddress[];
  policy?: PublisherRuntimePolicy;
}

export interface DesktopOptions {
  subscriber?: DesktopSubscriberOptions;
  publisher?: DesktopPublisherOptions;
}

export interface DesktopConfigContext {
  homeDirectory: string;
  config?: KeposConfig;
  environment?: Record<string, string | undefined>;
}

export interface LoadDesktopOptionsContext {
  homeDirectory: string;
  environment?: NodeJS.ProcessEnv;
  loadConfig?: typeof loadKeposConfig;
}

export async function loadDesktopOptions(
  arguments_: readonly string[],
  context: LoadDesktopOptionsContext,
): Promise<DesktopOptions> {
  const configOption = arguments_[0] === "--config";
  if (arguments_.length > 0 && !configOption) {
    return parseDesktopOptions(arguments_);
  }
  if (configOption && arguments_.length !== 2) {
    throw new Error("--config requires exactly one path");
  }
  const configPath = configOption ? arguments_[1] : undefined;
  const config = await (context.loadConfig ?? loadKeposConfig)(
    configPath,
    context.environment,
    context.homeDirectory,
  );
  return parseDesktopOptions([], {
    homeDirectory: context.homeDirectory,
    environment: context.environment,
    config,
  });
}

export function parseDesktopOptions(
  arguments_: readonly string[],
  context?: DesktopConfigContext,
): DesktopOptions {
  if (arguments_.length === 0 && context) {
    return optionsFromConfig(context);
  }
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

function optionsFromConfig(context: DesktopConfigContext): DesktopOptions {
  const stateHome =
    context.environment?.XDG_STATE_HOME ||
    path.join(context.homeDirectory, ".local", "state");
  const stateRoot = path.join(stateHome, "kepos-neo");
  const bootstrap = context.config?.network?.bootstrap;
  const publisherConfig = context.config?.publisher;
  const subscriberConfig = context.config?.subscriber;
  const options: DesktopOptions = {
    ...(publisherConfig?.enabled === true
      ? {
          publisher: {
            stateDir: path.join(stateRoot, "publisher"),
            ...(bootstrap ? { bootstrap } : {}),
            policy: {
              displayName: publisherConfig.displayName,
              allow: publisherConfig.allow,
              services: publisherConfig.services,
            },
          },
        }
      : {}),
    ...(subscriberConfig?.enabled === true
      ? {
          subscriber: {
            stateDir: path.join(stateRoot, "subscriber"),
            gatewayPort: subscriberConfig.gatewayPort ?? 17_480,
            ...(subscriberConfig.gatewayHost
              ? { gatewayHost: subscriberConfig.gatewayHost }
              : {}),
            ...(subscriberConfig.gatewayDomain
              ? { gatewayDomain: subscriberConfig.gatewayDomain }
              : {}),
            ...(bootstrap ? { bootstrap } : {}),
            ...(subscriberConfig.route
              ? { route: subscriberConfig.route }
              : {}),
            services: subscriberConfig.services ?? [],
          },
        }
      : {}),
  };
  if (!options.publisher && !options.subscriber) {
    throw new Error("desktop config must enable at least one role");
  }
  return options;
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
