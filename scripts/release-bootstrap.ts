import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import extractZip from "extract-zip";

import {
  parseBootstrapAsset,
  requireBootstrapAsset,
} from "../src/bootstrap-asset.js";
import type { DhtAddress } from "../src/mux/hyperdht.js";

export async function readBootstrapAssetFile(
  assetPath: string,
  label: string,
  required: boolean,
): Promise<DhtAddress[] | undefined> {
  let source: string;
  try {
    source = await readFile(assetPath, "utf8");
  } catch (error) {
    throw new Error(`${label} bootstrap asset cannot be read`, { cause: error });
  }

  let bootstrap: DhtAddress[] | undefined;
  try {
    bootstrap = parseBootstrapAsset(source);
  } catch (error) {
    throw new Error(`${label} bootstrap asset is invalid`, { cause: error });
  }
  if (required) requireBootstrapAsset(bootstrap);
  return bootstrap;
}

export function assertBootstrapAssetMatches(
  expected: DhtAddress[] | undefined,
  actual: DhtAddress[] | undefined,
  label: string,
): void {
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error(`${label} bootstrap asset differs from the canonical asset`);
  }
}

export async function verifyBootstrapAssetFiles(options: {
  expectedPath: string;
  actualPath: string;
  label: string;
  required?: boolean;
}): Promise<void> {
  const required = options.required ?? true;
  const [expected, actual] = await Promise.all([
    readBootstrapAssetFile(options.expectedPath, "canonical", required),
    readBootstrapAssetFile(options.actualPath, options.label, required),
  ]);
  assertBootstrapAssetMatches(expected, actual, options.label);
}

export async function verifyBootstrapAssetArchive(options: {
  archivePath: string;
  entryPath: string;
  expected: DhtAddress[];
  label: string;
}): Promise<void> {
  const extractionDirectory = await mkdtemp(
    path.join(os.tmpdir(), "kepos-bootstrap-artifact-"),
  );
  try {
    await extractZip(options.archivePath, { dir: extractionDirectory });
    const actualPath = path.join(extractionDirectory, ...options.entryPath.split("/"));
    const actual = await readBootstrapAssetFile(actualPath, options.label, true);
    assertBootstrapAssetMatches(options.expected, actual, options.label);
  } finally {
    await rm(extractionDirectory, { force: true, recursive: true });
  }
}
