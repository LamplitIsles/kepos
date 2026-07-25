import {
  defaultKeposConfigPath,
  saveKeposConfig,
  type KeposConfig,
} from "../../../src/app-config.js";
import type { DesktopRuntimeConfiguration } from "./runtime.js";
import {
  parseDesktopOptions,
  type DesktopOptions,
} from "./options.js";

export interface ApplyDesktopConfigContext {
  homeDirectory: string;
  environment?: NodeJS.ProcessEnv;
  configPath?: string;
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
  });
  const configPath =
    context.configPath ??
    defaultKeposConfigPath(context.environment, context.homeDirectory);
  await (context.saveConfig ?? saveKeposConfig)(config, configPath);
  await context.reconfigure(options);
  return options;
}
