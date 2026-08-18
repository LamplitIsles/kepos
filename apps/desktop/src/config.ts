import {
  loadKeposConfig,
  saveKeposConfig,
  type KeposConfig,
} from "../../../src/app-config.js";
import { defaultKeposConfigPath } from "../../../src/platform/paths.js";
import type { DesktopRuntimeConfiguration } from "./runtime.js";
import {
  parseDesktopOptions,
  type DesktopOptions,
} from "./options.js";

export interface ApplyDesktopConfigContext {
  homeDirectory: string;
  environment?: NodeJS.ProcessEnv;
  configPath?: string;
  platform?: NodeJS.Platform;
  saveConfig?: typeof saveKeposConfig;
  reconfigure(configuration: DesktopRuntimeConfiguration): Promise<void>;
}

export async function applyDesktopConfig(
  config: KeposConfig,
  context: ApplyDesktopConfigContext,
): Promise<DesktopOptions> {
  const options = parseDesktopOptions([], {
    homeDirectory: context.homeDirectory,
    environment: context.environment,
    config,
    configPath:
      context.configPath ??
      defaultKeposConfigPath(
        context.environment,
        context.homeDirectory,
        context.platform,
      ),
    platform: context.platform,
  });
  const configPath =
    context.configPath ??
    defaultKeposConfigPath(
      context.environment,
      context.homeDirectory,
      context.platform,
    );
  await (context.saveConfig ?? saveKeposConfig)(config, configPath);
  await context.reconfigure(options);
  return options;
}

export async function persistDesktopPublisherAllowlist(
  configPath: string,
  allow: string[],
  dependencies: {
    loadConfig?: typeof loadKeposConfig;
    saveConfig?: typeof saveKeposConfig;
  } = {},
): Promise<void> {
  const config = await (dependencies.loadConfig ?? loadKeposConfig)(configPath);
  if (!config?.publisher?.enabled) {
    throw new Error("Desktop publisher config is not enabled");
  }
  await (dependencies.saveConfig ?? saveKeposConfig)(
    {
      ...config,
      publisher: { ...config.publisher, allow },
    },
    configPath,
  );
}
