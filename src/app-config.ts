import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import type { PeerConfig } from "./config.js";
import { parseKeposConfig, serializeKeposConfig } from "./config-toml.js";
export { parseKeposConfig, serializeKeposConfig } from "./config-toml.js";
import { defaultKeposConfigPath } from "./platform/paths.js";
import { replaceFileAtomically } from "./state/files.js";

/** The one canonical configuration type read by every repository-owned host. */
export type KeposConfig = PeerConfig;

export async function loadKeposConfig(
  configPath?: string,
  environment?: NodeJS.ProcessEnv,
  homeDirectory?: string,
  platform?: NodeJS.Platform,
): Promise<KeposConfig | undefined> {
  const source = await readKeposConfigSource(
    configPath,
    environment,
    homeDirectory,
    platform,
  );
  return source === undefined ? undefined : parseKeposConfig(source);
}

async function readKeposConfigSource(
  configPath: string | undefined,
  environment: NodeJS.ProcessEnv | undefined,
  homeDirectory: string | undefined,
  platform?: NodeJS.Platform,
): Promise<string | undefined> {
  const resolvedPath =
    configPath ?? defaultKeposConfigPath(environment, homeDirectory, platform);
  try {
    return await readFile(resolvedPath, "utf8");
  } catch (error) {
    if (
      configPath === undefined &&
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return undefined;
    }
    throw new Error(`Cannot read Kepos config: ${resolvedPath}`, {
      cause: error,
    });
  }
}

export async function saveKeposConfig(
  config: KeposConfig,
  configPath = defaultKeposConfigPath(),
): Promise<void> {
  const source = serializeKeposConfig(config);
  const directory = path.dirname(configPath);
  await mkdir(directory, { mode: 0o700, recursive: true });
  const temporaryDirectory = await mkdtemp(path.join(directory, ".config-"));
  const temporaryPath = path.join(temporaryDirectory, "config.toml");
  try {
    await writeFile(temporaryPath, source, { flag: "wx", mode: 0o600 });
    await replaceFileAtomically(temporaryPath, configPath);
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
}
