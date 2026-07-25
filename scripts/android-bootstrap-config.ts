import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { loadKeposBootstrap } from "../src/app-config.js";

export async function writeAndroidBootstrapAsset(options: {
  outputPath: string;
  environment?: NodeJS.ProcessEnv;
  homeDirectory?: string;
}): Promise<void> {
  const outputDirectory = path.dirname(options.outputPath);
  await rm(outputDirectory, { force: true, recursive: true });
  await mkdir(outputDirectory, { recursive: true });
  const bootstrap = await loadKeposBootstrap(
    undefined,
    options.environment,
    options.homeDirectory,
  );
  await writeFile(options.outputPath, `${JSON.stringify(bootstrap ?? null)}\n`, {
    mode: 0o600,
  });
}
