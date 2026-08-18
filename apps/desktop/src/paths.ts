import {
  defaultKeposConfigPath,
  defaultKeposRoleStatePath,
} from "../../../src/platform/paths.js";

export interface DesktopPathsContext {
  homeDirectory: string;
  environment?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
}

export interface DesktopPaths {
  configPath: string;
  publisherStateDir: string;
  subscriberStateDir: string;
}

export function defaultDesktopPaths(
  context: DesktopPathsContext,
): DesktopPaths {
  return {
    configPath: defaultKeposConfigPath(
      context.environment,
      context.homeDirectory,
      context.platform,
    ),
    publisherStateDir: defaultKeposRoleStatePath(
      "publisher",
      context.environment,
      context.homeDirectory,
      context.platform,
    ),
    subscriberStateDir: defaultKeposRoleStatePath(
      "subscriber",
      context.environment,
      context.homeDirectory,
      context.platform,
    ),
  };
}
