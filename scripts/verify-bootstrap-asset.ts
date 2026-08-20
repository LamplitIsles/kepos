import { fileURLToPath } from "node:url";

import { verifyBootstrapAssetFiles } from "./release-bootstrap.js";

export function parseBootstrapVerificationArguments(
  arguments_: readonly string[],
): { expectedPath: string; actualPath: string } {
  if (arguments_.length !== 2 || !arguments_[0] || !arguments_[1]) {
    throw new Error(
      "usage: verify-bootstrap-asset.ts <canonical-path> <artifact-path>",
    );
  }
  return { expectedPath: arguments_[0], actualPath: arguments_[1] };
}

export async function verifyBootstrapAsset(
  arguments_: readonly string[],
): Promise<void> {
  const options = parseBootstrapVerificationArguments(arguments_);
  await verifyBootstrapAssetFiles({
    ...options,
    label: "Windows artifact",
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await verifyBootstrapAsset(process.argv.slice(2));
}
