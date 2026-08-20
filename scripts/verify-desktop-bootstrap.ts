import { fileURLToPath } from "node:url";

import { loadKeposConfig } from "../src/app-config.js";
import { requireBootstrapAsset } from "../src/bootstrap-asset.js";
import {
  assertBootstrapAssetMatches,
  readBootstrapAssetFile,
} from "./release-bootstrap.js";

export function parseDesktopBootstrapVerificationArguments(
  arguments_: readonly string[],
): { expectedPath: string; configPath: string } {
  if (arguments_.length !== 2 || !arguments_[0] || !arguments_[1]) {
    throw new Error(
      "usage: verify-desktop-bootstrap.ts <canonical-path> <config-path>",
    );
  }
  return { expectedPath: arguments_[0], configPath: arguments_[1] };
}

export async function verifyDesktopBootstrap(
  arguments_: readonly string[],
): Promise<void> {
  const { expectedPath, configPath } =
    parseDesktopBootstrapVerificationArguments(arguments_);
  const expected = await readBootstrapAssetFile(
    expectedPath,
    "canonical",
    false,
  );
  const config = await loadKeposConfig(configPath);
  const actual = config?.network?.bootstrap;
  if (expected !== undefined) requireBootstrapAsset(actual);
  assertBootstrapAssetMatches(expected, actual, "Windows first-run config");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await verifyDesktopBootstrap(process.argv.slice(2));
}
