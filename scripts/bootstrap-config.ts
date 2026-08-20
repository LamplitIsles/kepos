import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { loadKeposBootstrap } from "../src/app-config.js";
import { requireBootstrapAsset } from "../src/bootstrap-asset.js";
import type { DhtAddress } from "../src/mux/hyperdht.js";
import { replaceFileAtomically } from "../src/state/files.js";

export async function loadRequiredKeposBootstrap(
  environment?: NodeJS.ProcessEnv,
  homeDirectory?: string,
  platform?: NodeJS.Platform,
): Promise<DhtAddress[]> {
  return requireBootstrapAsset(
    await loadKeposBootstrap(undefined, environment, homeDirectory, platform),
  );
}

export async function writeKeposBootstrapAsset(options: {
  outputPath: string;
  environment?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  platform?: NodeJS.Platform;
  mode?: number;
  required?: boolean;
}): Promise<DhtAddress[] | undefined> {
  const outputDirectory = path.dirname(options.outputPath);
  await mkdir(outputDirectory, { recursive: true });
  const temporaryDirectory = await mkdtemp(
    path.join(outputDirectory, ".bootstrap-"),
  );
  const temporaryPath = path.join(
    temporaryDirectory,
    path.basename(options.outputPath),
  );
  let bootstrap: DhtAddress[] | undefined;
  try {
    bootstrap = await loadKeposBootstrap(
      undefined,
      options.environment,
      options.homeDirectory,
      options.platform,
    );
    if (options.required) requireBootstrapAsset(bootstrap);
    await writeFile(temporaryPath, `${JSON.stringify(bootstrap ?? null)}\n`, {
      mode: options.mode ?? 0o600,
    });
    await replaceFileAtomically(temporaryPath, options.outputPath);
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
  return bootstrap;
}
