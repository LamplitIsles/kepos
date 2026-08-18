import {
  loadKeposConfig,
  saveKeposConfig,
  type KeposConfig,
} from "../../../src/app-config.js";
import { DEFAULT_GATEWAY_PORT } from "../../../src/home/gateway.js";
import {
  setupSubscriber,
  type SetupSubscriberResult,
} from "../../../src/state/subscriber.js";
import { defaultDesktopPaths } from "./paths.js";

const defaultSubscriberConfig: KeposConfig = {
  subscriber: {
    enabled: true,
    gatewayPort: DEFAULT_GATEWAY_PORT,
    services: [],
  },
};

export interface DesktopBootstrapContext {
  homeDirectory: string;
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  loadConfig?: typeof loadKeposConfig;
  saveConfig?: typeof saveKeposConfig;
  setupSubscriber?: typeof setupSubscriber;
}

export interface DesktopBootstrapResult {
  config: KeposConfig;
  configPath: string;
  subscriber?: SetupSubscriberResult;
}

export async function ensureDesktopBootstrap(
  context: DesktopBootstrapContext,
): Promise<DesktopBootstrapResult> {
  const paths = defaultDesktopPaths(context);
  const config = await (context.loadConfig ?? loadKeposConfig)(
    undefined,
    context.environment,
    context.homeDirectory,
    context.platform,
  );
  if (config === undefined) {
    const subscriber = await (context.setupSubscriber ?? setupSubscriber)({
      stateDir: paths.subscriberStateDir,
    });
    await (context.saveConfig ?? saveKeposConfig)(
      defaultSubscriberConfig,
      paths.configPath,
    );
    return {
      config: defaultSubscriberConfig,
      configPath: paths.configPath,
      subscriber,
    };
  }

  const subscriber =
    config.subscriber?.enabled === true
      ? await (context.setupSubscriber ?? setupSubscriber)({
          stateDir: paths.subscriberStateDir,
        })
      : undefined;
  return {
    config,
    configPath: paths.configPath,
    ...(subscriber ? { subscriber } : {}),
  };
}
