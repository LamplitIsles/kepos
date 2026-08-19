import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { loadKeposBootstrap } from "../src/app-config.js";
import { replaceFileAtomically } from "../src/state/files.js";

export async function writeKeposBootstrapAsset(options: {
  outputPath: string;
  environment?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  platform?: NodeJS.Platform;
  mode?: number;
}): Promise<void> {
  const outputDirectory = path.dirname(options.outputPath);
  await mkdir(outputDirectory, { recursive: true });
  const temporaryDirectory = await mkdtemp(
    path.join(outputDirectory, ".bootstrap-"),
  );
  const temporaryPath = path.join(
    temporaryDirectory,
    path.basename(options.outputPath),
  );
  try {
    const bootstrap = await loadKeposBootstrap(
      undefined,
      options.environment,
      options.homeDirectory,
      options.platform,
    );
    await writeFile(temporaryPath, `${JSON.stringify(bootstrap ?? null)}\n`, {
      mode: options.mode ?? 0o600,
    });
    await replaceFileAtomically(temporaryPath, options.outputPath);
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
}
