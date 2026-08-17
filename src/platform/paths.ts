import os from "node:os";
import path from "node:path";
import process from "node:process";

export type PlatformEnvironment = Readonly<
  Record<string, string | undefined>
>;

function pathForPlatform(platform: NodeJS.Platform): typeof path {
  return platform === "win32" ? path.win32 : path.posix;
}

export function defaultKeposConfigPath(
  environment: PlatformEnvironment = process.env,
  homeDirectory = os.homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  const pathApi = pathForPlatform(platform);
  const configHome =
    platform === "win32"
      ? (environment.APPDATA ||
        pathApi.join(homeDirectory, "AppData", "Roaming"))
      : (environment.XDG_CONFIG_HOME ||
        pathApi.join(homeDirectory, ".config"));
  return pathApi.join(
    configHome,
    platform === "win32" ? "Kepos" : "kepos",
    "config.toml",
  );
}

export function defaultKeposRoleStatePath(
  role: "publisher" | "subscriber",
  environment: PlatformEnvironment = process.env,
  homeDirectory = os.homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  return pathForPlatform(platform).join(
    defaultKeposStateRoot(environment, homeDirectory, platform),
    role,
  );
}

export function defaultKeposStateRoot(
  environment: PlatformEnvironment = process.env,
  homeDirectory = os.homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  const pathApi = pathForPlatform(platform);
  const stateHome =
    platform === "win32"
      ? (environment.LOCALAPPDATA ||
        pathApi.join(homeDirectory, "AppData", "Local"))
      : (environment.XDG_STATE_HOME ||
        pathApi.join(homeDirectory, ".local", "state"));
  return platform === "win32"
    ? pathApi.join(stateHome, "Kepos", "state")
    : pathApi.join(stateHome, "kepos-neo");
}
