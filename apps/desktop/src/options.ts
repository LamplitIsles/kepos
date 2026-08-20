import path from "node:path";

import {
  loadKeposConfig,
  saveKeposConfig,
  type KeposConfig,
} from "../../../src/app-config.js";
import { ensureDesktopBootstrap } from "./bootstrap.js";
import { defaultDesktopPaths } from "./paths.js";
import { DEFAULT_GATEWAY_PORT } from "../../../src/home/gateway.js";
import type { DhtAddress } from "../../../src/mux/hyperdht.js";
import type { Route } from "../../../src/mux/route.js";
import type { PublisherRuntimePolicy } from "../../../src/runtime/publisher.js";
import type { SubscriberService } from "../../../src/runtime/subscriber.js";
import { setupSubscriber } from "../../../src/state/subscriber.js";

export interface DesktopSubscriberSetup {
  configured: boolean;
  publicKey: string;
  error?: string;
}

export interface DesktopSubscriberOptions {
  stateDir: string;
  gatewayPort: number;
  subscriberSetup?: DesktopSubscriberSetup;
  gatewayHost?: string;
  gatewayDomain?: string;
  route?: Route;
  services: SubscriberService[];
}

export interface DesktopPublisherOptions {
  stateDir: string;
  configPath?: string;
  policy?: PublisherRuntimePolicy;
}

export interface DesktopOptions {
  bootstrap?: DhtAddress[];
  subscriber?: DesktopSubscriberOptions;
  publisher?: DesktopPublisherOptions;
}

export interface DesktopConfigContext {
  homeDirectory: string;
  config?: KeposConfig;
  environment?: Record<string, string | undefined>;
  configPath?: string;
  platform?: NodeJS.Platform;
}

export interface LoadDesktopOptionsContext {
  homeDirectory: string;
  environment?: NodeJS.ProcessEnv;
  executablePath?: string;
  loadConfig?: typeof loadKeposConfig;
  saveConfig?: typeof saveKeposConfig;
  setupSubscriber?: typeof setupSubscriber;
  platform?: NodeJS.Platform;
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
  if (configOption) {
    const configPath = arguments_[1];
    const config = await (context.loadConfig ?? loadKeposConfig)(
      configPath,
      context.environment,
      context.homeDirectory,
      context.platform,
    );
    return parseDesktopOptions([], {
      homeDirectory: context.homeDirectory,
      environment: context.environment,
      config,
      configPath,
      platform: context.platform,
    });
  }

  const bootstrapped = await ensureDesktopBootstrap(context);
  const options = parseDesktopOptions([], {
    homeDirectory: context.homeDirectory,
    environment: context.environment,
    config: bootstrapped.config,
    configPath: bootstrapped.configPath,
    platform: context.platform,
  });
  if (options.subscriber && bootstrapped.subscriber?.configured === false) {
    options.subscriber = {
      ...options.subscriber,
      subscriberSetup: {
        configured: false,
        publicKey: bootstrapped.subscriber.publicKey,
      },
    };
  }
  return options;
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
            gatewayPort: DEFAULT_GATEWAY_PORT,
            services,
          },
        }
      : {}),
  };
}

function optionsFromConfig(context: DesktopConfigContext): DesktopOptions {
  const paths = defaultDesktopPaths(context);
  const bootstrap = context.config?.network?.bootstrap;
  const publisherConfig = context.config?.publisher;
  const subscriberConfig = context.config?.subscriber;
  const options: DesktopOptions = {
    ...(bootstrap ? { bootstrap } : {}),
    ...(publisherConfig?.enabled === true
      ? {
          publisher: {
            stateDir: paths.publisherStateDir,
            ...(context.configPath ? { configPath: context.configPath } : {}),
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
            stateDir: paths.subscriberStateDir,
            gatewayPort: subscriberConfig.gatewayPort ?? DEFAULT_GATEWAY_PORT,
            ...(subscriberConfig.gatewayHost
              ? { gatewayHost: subscriberConfig.gatewayHost }
              : {}),
            ...(subscriberConfig.gatewayDomain
              ? { gatewayDomain: subscriberConfig.gatewayDomain }
              : {}),
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
