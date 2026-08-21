import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MANIFEST_FILE = "self-contained-runtime.json";

type ValidatedManifest = Readonly<{
  readonly files: readonly Readonly<{ readonly path: string }>[];
}>;
type ProductFileSet = readonly string[];

// The adapter owns the manifest schema. Kepos only consumes the validated
// paths needed to copy runtime files and distinguish them from product files.
const adapter = createRequire(import.meta.url)(
  "../../vendor/holepunch/bare-win-ui/cmake/self-contained-runtime.js",
) as {
  validateManifest: (
    manifestPath: string,
    options?: { root?: string },
  ) => ValidatedManifest;
};

export function windowsSelfContainedRuntimeRoot(repository: string): string {
  return path.join(
    repository,
    "vendor",
    "holepunch",
    "bare-win-ui",
    "prebuilds",
    "win32-x64",
    "bare",
  );
}

function assertContained(root: string, candidate: string, label: string): void {
  const relative = path.relative(root, candidate);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`${label} escapes its owned root`);
  }
}

async function lstatIfPresent(file: string) {
  try {
    return await lstat(file);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
}

async function requireDirectory(root: string, label: string): Promise<void> {
  const details = await lstat(root);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory: ${root}`);
  }
}

async function requireRegularFile(
  root: string,
  file: string,
  label: string,
): Promise<void> {
  const details = await lstat(file);
  if (!details.isFile() || details.isSymbolicLink() || details.nlink > 1) {
    throw new Error(`${label} must be a regular non-linked file: ${file}`);
  }
  const rootReal = await realpath(root);
  const fileReal = await realpath(file);
  assertContained(rootReal, fileReal, label);
}

async function prepareDestination(
  root: string,
  destination: string,
  label: string,
): Promise<void> {
  const rootPath = path.resolve(root);
  const destinationPath = path.resolve(destination);
  assertContained(rootPath, destinationPath, label);
  await mkdir(destinationPath, { recursive: true });
  const rootReal = await realpath(rootPath);
  const destinationReal = await realpath(destinationPath);
  assertContained(rootReal, destinationReal, label);
  await requireDirectory(destinationPath, label);
}

function manifestPath(root: string): string {
  return path.join(root, MANIFEST_FILE);
}

function manifestEntries(manifest: ValidatedManifest): readonly string[] {
  return manifest.files.map((entry) => entry.path);
}

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function collectRegularFiles(
  root: string,
  relativeDirectory = "",
): Promise<string[]> {
  const directory = path.join(
    root,
    ...(relativeDirectory ? relativeDirectory.split("/") : []),
  );
  const entries = (await readdir(directory, { withFileTypes: true })).sort(
    (left, right) => compareOrdinal(left.name, right.name),
  );
  const files: string[] = [];

  for (const entry of entries) {
    const relativePath = relativeDirectory
      ? `${relativeDirectory}/${entry.name}`
      : entry.name;
    const absolutePath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`payload contains a link: ${relativePath}`);
    }
    if (entry.isDirectory()) {
      files.push(...(await collectRegularFiles(root, relativePath)));
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`payload contains a non-file entry: ${relativePath}`);
    }
    await requireRegularFile(root, absolutePath, "payload file");
    files.push(relativePath);
  }

  return files;
}

async function getProductFiles(
  appRoot: string,
  manifest: ValidatedManifest,
): Promise<ProductFileSet> {
  const runtimeFiles = new Set([MANIFEST_FILE, ...manifestEntries(manifest)]);
  const files = await collectRegularFiles(appRoot);
  return files
    .filter((relativePath) => !runtimeFiles.has(relativePath))
    .sort(compareOrdinal);
}

async function copyValidatedFile(
  sourceRoot: string,
  destinationRoot: string,
  relativePath: string,
): Promise<void> {
  const source = path.resolve(sourceRoot, ...relativePath.split("/"));
  const destination = path.resolve(destinationRoot, ...relativePath.split("/"));
  assertContained(path.resolve(sourceRoot), source, "runtime source file");
  assertContained(
    path.resolve(destinationRoot),
    destination,
    "runtime destination file",
  );
  await requireRegularFile(sourceRoot, source, "runtime source file");
  await prepareDestination(
    destinationRoot,
    path.dirname(destination),
    "runtime destination directory",
  );

  const existing = await lstatIfPresent(destination);
  if (
    existing &&
    (!existing.isFile() || existing.isSymbolicLink() || existing.nlink > 1)
  ) {
    throw new Error(
      `runtime destination is not a replaceable file: ${destination}`,
    );
  }
  await copyFile(source, destination);
  await requireRegularFile(
    destinationRoot,
    destination,
    "runtime destination file",
  );
}

export interface WindowsSelfContainedRuntimeStage {
  readonly fileCount: number;
  readonly manifestSha256: string;
  readonly productFiles: ProductFileSet;
}

export async function stageValidatedWindowsSelfContainedRuntime(
  sourceRoot: string,
  destinationRoot: string,
): Promise<WindowsSelfContainedRuntimeStage> {
  const sourceManifest = manifestPath(sourceRoot);

  await requireDirectory(sourceRoot, "self-contained runtime source");
  await requireRegularFile(
    sourceRoot,
    sourceManifest,
    "self-contained runtime manifest",
  );
  const manifest = adapter.validateManifest(sourceManifest, {
    root: sourceRoot,
  });

  await requireDirectory(destinationRoot, "desktop App output");
  await copyValidatedFile(sourceRoot, destinationRoot, MANIFEST_FILE);
  for (const entry of manifestEntries(manifest)) {
    await copyValidatedFile(sourceRoot, destinationRoot, entry);
  }

  const manifestBytes = await readFile(sourceManifest);
  return {
    fileCount: manifestEntries(manifest).length,
    manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
    productFiles: await getProductFiles(destinationRoot, manifest),
  };
}

export async function stageWindowsSelfContainedRuntime(
  repository: string,
): Promise<WindowsSelfContainedRuntimeStage> {
  return stageValidatedWindowsSelfContainedRuntime(
    windowsSelfContainedRuntimeRoot(repository),
    path.join(repository, "dist", "desktop", "Kepos", "App"),
  );
}

function normalizeProductFilePath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Windows product file paths must be non-empty strings");
  }
  if (
    value.includes("\\") ||
    value.includes("\0") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/.test(value)
  ) {
    throw new Error(`Windows product file path is not relative: ${value}`);
  }
  const segments = value.split("/");
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    throw new Error(`Windows product file path is unsafe: ${value}`);
  }
  if (path.posix.normalize(value) !== value) {
    throw new Error(`Windows product file path is not normalized: ${value}`);
  }
  if (value === MANIFEST_FILE) {
    throw new Error(
      "Windows product file set must not contain the runtime manifest",
    );
  }
  return value;
}

async function readProductFileSet(file: string): Promise<ProductFileSet> {
  const details = await lstat(file);
  if (!details.isFile() || details.isSymbolicLink() || details.nlink > 1) {
    throw new Error(`Windows product file set must be a regular file: ${file}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read Windows product file set: ${file}`, {
      cause: error,
    });
  }
  if (!Array.isArray(parsed)) {
    throw new Error("Windows product file set must be an array");
  }

  const productFiles = parsed.map(normalizeProductFilePath);
  const sorted = [...productFiles].sort(compareOrdinal);
  if (
    sorted.length !== new Set(productFiles).size ||
    sorted.some((value, index) => value !== productFiles[index])
  ) {
    throw new Error(
      "Windows product file set must be unique and ordinal-sorted",
    );
  }
  return productFiles;
}

async function requireProductFilesInSource(
  sourceAppRoot: string,
  productFiles: ProductFileSet,
): Promise<void> {
  const sourceFiles = new Set(await collectRegularFiles(sourceAppRoot));
  for (const relativePath of productFiles) {
    if (!sourceFiles.has(relativePath)) {
      throw new Error(
        `clean Windows source package is missing product file: ${relativePath}`,
      );
    }
  }
}

async function copyFinalPayload(
  sourceRoot: string,
  destinationRoot: string,
  productFiles: ReadonlySet<string>,
  relativeDirectory = "",
): Promise<void> {
  const sourceDirectory = path.join(
    sourceRoot,
    ...(relativeDirectory ? relativeDirectory.split("/") : []),
  );
  const destinationDirectory = path.join(
    destinationRoot,
    ...(relativeDirectory ? relativeDirectory.split("/") : []),
  );
  const entries = (
    await readdir(sourceDirectory, { withFileTypes: true })
  ).sort((left, right) => compareOrdinal(left.name, right.name));
  if (relativeDirectory && entries.length === 0) {
    throw new Error(
      `final Windows App contains an empty directory: ${relativeDirectory}`,
    );
  }
  await prepareDestination(
    destinationRoot,
    destinationDirectory,
    "runtime validation directory",
  );

  for (const entry of entries) {
    const relativePath = relativeDirectory
      ? `${relativeDirectory}/${entry.name}`
      : entry.name;
    const source = path.join(sourceDirectory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`final Windows App contains a link: ${relativePath}`);
    }
    if (entry.isDirectory()) {
      await copyFinalPayload(
        sourceRoot,
        destinationRoot,
        productFiles,
        relativePath,
      );
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(
        `final Windows App contains a non-file entry: ${relativePath}`,
      );
    }
    await requireRegularFile(sourceRoot, source, "final Windows App payload");

    // The exact product set comes from the clean source package and the
    // adapter's validated manifest. Every other App file remains visible to
    // the adapter validator as runtime payload.
    if (productFiles.has(relativePath)) continue;
    await copyValidatedFile(sourceRoot, destinationRoot, relativePath);
  }
}

function sameFileSet(left: ProductFileSet, right: ProductFileSet): boolean {
  return (
    left.length === right.length &&
    left.every((relativePath, index) => relativePath === right[index])
  );
}

export async function validateFinalWindowsSelfContainedRuntime(
  sourceRoot: string,
  sourceAppRoot: string,
  appRoot: string,
  productFiles: ProductFileSet,
  validationRoot: string,
): Promise<Omit<WindowsSelfContainedRuntimeStage, "productFiles">> {
  await requireDirectory(sourceRoot, "self-contained runtime source");
  await requireDirectory(sourceAppRoot, "clean Windows source package");
  await requireDirectory(appRoot, "final extracted Windows App");
  await requireRegularFile(
    sourceRoot,
    manifestPath(sourceRoot),
    "native self-contained runtime manifest",
  );
  await requireRegularFile(
    appRoot,
    manifestPath(appRoot),
    "final self-contained runtime manifest",
  );
  await requireProductFilesInSource(sourceAppRoot, productFiles);

  const sourceManifestBytes = await readFile(manifestPath(sourceRoot));
  const finalManifestBytes = await readFile(manifestPath(appRoot));
  if (!sourceManifestBytes.equals(finalManifestBytes)) {
    throw new Error(
      "final self-contained runtime manifest differs from native source",
    );
  }

  const existingValidationRoot = await lstatIfPresent(validationRoot);
  if (existingValidationRoot) {
    throw new Error(
      `runtime validation directory already exists: ${validationRoot}`,
    );
  }
  await mkdir(validationRoot, { recursive: true });
  await copyFinalPayload(appRoot, validationRoot, new Set(productFiles));

  const manifest = adapter.validateManifest(manifestPath(validationRoot), {
    root: validationRoot,
  });
  const finalProductFiles = await getProductFiles(appRoot, manifest);
  if (!sameFileSet(productFiles, finalProductFiles)) {
    throw new Error(
      "final Windows App product file set differs from the clean source package",
    );
  }

  return {
    fileCount: manifestEntries(manifest).length,
    manifestSha256: createHash("sha256")
      .update(finalManifestBytes)
      .digest("hex"),
  };
}

async function main(): Promise<void> {
  const [command, ...arguments_] = process.argv.slice(2);
  if (command !== "validate-final" || arguments_.length !== 5) {
    throw new Error(
      `Usage: ${path.basename(process.argv[1] ?? "self-contained-runtime.ts")} validate-final <native-runtime-root> <source-App-root> <extracted-App-root> <product-files-path> <validation-root>`,
    );
  }
  const result = await validateFinalWindowsSelfContainedRuntime(
    arguments_[0]!,
    arguments_[1]!,
    arguments_[2]!,
    await readProductFileSet(arguments_[3]!),
    arguments_[4]!,
  );
  process.stdout.write(
    `self-contained-runtime-manifest-count=${result.fileCount}\nself-contained-runtime-manifest-sha256=${result.manifestSha256}\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
