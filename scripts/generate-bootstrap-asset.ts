import { fileURLToPath } from "node:url";

import { writeKeposBootstrapAsset } from "./bootstrap-config.js";

export function parseBootstrapGenerationArguments(arguments_: readonly string[]): {
  outputPath: string;
  required: boolean;
} {
  if (arguments_.length !== 2 || !arguments_[0]) {
    throw new Error(
      "usage: generate-bootstrap-asset.ts <output-path> <required|optional>",
    );
  }
  if (arguments_[1] !== "required" && arguments_[1] !== "optional") {
    throw new Error(
      "usage: generate-bootstrap-asset.ts <output-path> <required|optional>",
    );
  }
  return { outputPath: arguments_[0], required: arguments_[1] === "required" };
}

export async function generateBootstrapAsset(
  arguments_: readonly string[],
  environment?: NodeJS.ProcessEnv,
): Promise<void> {
  const options = parseBootstrapGenerationArguments(arguments_);
  await writeKeposBootstrapAsset({ ...options, environment });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await generateBootstrapAsset(process.argv.slice(2));
}
