import process from "node:process";
import path from "node:path";

import {
  defaultKeposConfigPath,
  defaultKeposDiagnosticsDirectory,
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

export const DESKTOP_BOOTSTRAP_ASSET = "kepos-bootstrap.json";

export function desktopBootstrapAssetPath(
  executablePath = process.execPath,
  platform: NodeJS.Platform = process.platform,
): string {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const executableDirectory = pathApi.dirname(executablePath);
  if (platform === "darwin") {
    return pathApi.join(
      pathApi.dirname(executableDirectory),
      "Resources",
      DESKTOP_BOOTSTRAP_ASSET,
    );
  }
  if (platform === "win32") {
    return pathApi.join(executableDirectory, DESKTOP_BOOTSTRAP_ASSET);
  }
  throw new Error(`unsupported desktop asset platform: ${platform}`);
}

export function defaultDesktopDiagnosticsDirectory(
  context: DesktopPathsContext,
): string {
  return defaultKeposDiagnosticsDirectory(
    context.environment,
    context.homeDirectory,
    context.platform,
  );
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
