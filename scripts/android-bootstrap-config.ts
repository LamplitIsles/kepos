import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { loadKeposConfig } from "../src/app-config.js";

export async function writeAndroidBootstrapAsset(options: {
  outputPath: string;
  environment?: NodeJS.ProcessEnv;
  homeDirectory?: string;
}): Promise<void> {
  const config = await loadKeposConfig(
    undefined,
    options.environment,
    options.homeDirectory,
  );
  const bootstrap = config?.network?.bootstrap ?? null;
  await mkdir(path.dirname(options.outputPath), { recursive: true });
  await writeFile(options.outputPath, `${JSON.stringify(bootstrap)}\n`, {
    mode: 0o600,
  });
}
