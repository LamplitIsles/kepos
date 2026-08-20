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

// These are Kepos files, not runtime payload files. The adapter manifest owns
// every other file under App during the final extracted-ZIP validation.
const PRODUCT_FILE_PATTERNS = [
  /^Kepos\.exe$/,
  /^kepos-bootstrap\.json$/,
  /^app\.bundle$/,
  /^Microsoft\.Web\.WebView2\.Core\.dll$/,
  /^bare-(abort|buffer|crypto|dns|fs|hrtime|inspect|lief|module-lexer|os|path|pipe|signals|stdio|structured-clone|subprocess|tcp|tty|type|url|win-ui)-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\.dll$/,
  /^(sodium-native|udx-native)-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\.dll$/,
] as const;

const REQUIRED_PRODUCT_FILES = [
  "Kepos.exe",
  "kepos-bootstrap.json",
  "app.bundle",
  "Microsoft.Web.WebView2.Core.dll",
  "Microsoft.WindowsAppRuntime.dll",
  MANIFEST_FILE,
] as const;

// The adapter is the only manifest schema, inventory, path, architecture,
// size, hash, and link authority. The returned value is consumed opaquely so
// this capability does not redeclare its schema.
const adapter = createRequire(import.meta.url)(
  "../../vendor/holepunch/bare-win-ui/cmake/self-contained-runtime.js",
) as {
  validateManifest: (manifestPath: string, options?: { root?: string }) => any;
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
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
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
  if (
    !details.isFile() ||
    details.isSymbolicLink() ||
    details.nlink > 1
  ) {
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

function manifestEntries(manifest: any): readonly { path: string }[] {
  // `manifest` has already been accepted by the adapter validator. Do not
  // parse or validate its shape here; only consume the validator's inventory.
  return manifest.files;
}

async function copyValidatedFile(
  sourceRoot: string,
  destinationRoot: string,
  relativePath: string,
): Promise<void> {
  const source = path.resolve(sourceRoot, ...relativePath.split("/"));
  const destination = path.resolve(
    destinationRoot,
    ...relativePath.split("/"),
  );
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
    throw new Error(`runtime destination is not a replaceable file: ${destination}`);
  }
  await copyFile(source, destination);
  await requireRegularFile(
    destinationRoot,
    destination,
    "runtime destination file",
  );
}

export async function stageValidatedWindowsSelfContainedRuntime(
  sourceRoot: string,
  destinationRoot: string,
): Promise<{ fileCount: number; manifestSha256: string }> {
  const sourceManifest = manifestPath(sourceRoot);

  await requireDirectory(sourceRoot, "self-contained runtime source");
  await requireRegularFile(
    sourceRoot,
    sourceManifest,
    "self-contained runtime manifest",
  );
  const manifest = adapter.validateManifest(sourceManifest, { root: sourceRoot });

  await requireDirectory(destinationRoot, "desktop App output");
  await copyValidatedFile(sourceRoot, destinationRoot, MANIFEST_FILE);
  for (const entry of manifestEntries(manifest)) {
    await copyValidatedFile(sourceRoot, destinationRoot, entry.path);
  }

  const manifestBytes = await readFile(sourceManifest);
  return {
    fileCount: manifestEntries(manifest).length,
    manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
  };
}

export async function stageWindowsSelfContainedRuntime(
  repository: string,
): Promise<{ fileCount: number; manifestSha256: string }> {
  return stageValidatedWindowsSelfContainedRuntime(
    windowsSelfContainedRuntimeRoot(repository),
    path.join(repository, "dist", "desktop", "Kepos", "App"),
  );
}

function isProductFile(fileName: string): boolean {
  return PRODUCT_FILE_PATTERNS.some((pattern) => pattern.test(fileName));
}

async function copyFinalPayload(
  sourceRoot: string,
  destinationRoot: string,
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
  const entries = (await readdir(sourceDirectory, { withFileTypes: true })).sort(
    (left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0),
  );
  if (relativeDirectory && entries.length === 0) {
    throw new Error(`final Windows App contains an empty directory: ${relativeDirectory}`);
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
      await copyFinalPayload(sourceRoot, destinationRoot, relativePath);
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`final Windows App contains a non-file entry: ${relativePath}`);
    }
    await requireRegularFile(sourceRoot, source, "final Windows App payload");

    // Keep the product executable, bundle, bootstrap asset, WebView2 bridge,
    // and native addon DLLs out of the temporary payload view. Any other App
    // entry remains visible to the adapter validator and is rejected as
    // unmanifested payload.
    if (!relativeDirectory && isProductFile(entry.name)) continue;
    await copyValidatedFile(sourceRoot, destinationRoot, relativePath);
  }
}

async function requireProductFiles(appRoot: string): Promise<void> {
  const entries = await readdir(appRoot, { withFileTypes: true });
  const names = new Set(
    entries.filter((entry) => entry.isFile()).map((entry) => entry.name),
  );
  for (const required of REQUIRED_PRODUCT_FILES) {
    if (!names.has(required)) {
      throw new Error(`final Windows App is missing ${required}`);
    }
  }
  if (
    !entries.some(
      (entry) =>
        entry.isFile() && entry.name.startsWith("bare-win-ui-") && entry.name.endsWith(".dll"),
    )
  ) {
    throw new Error("final Windows App is missing the bare-win-ui runtime");
  }
}

export async function validateFinalWindowsSelfContainedRuntime(
  sourceRoot: string,
  appRoot: string,
  validationRoot: string,
): Promise<{ fileCount: number; manifestSha256: string }> {
  await requireDirectory(sourceRoot, "self-contained runtime source");
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
  await requireProductFiles(appRoot);

  const sourceManifestBytes = await readFile(manifestPath(sourceRoot));
  const finalManifestBytes = await readFile(manifestPath(appRoot));
  if (!sourceManifestBytes.equals(finalManifestBytes)) {
    throw new Error("final self-contained runtime manifest differs from native source");
  }

  const existingValidationRoot = await lstatIfPresent(validationRoot);
  if (existingValidationRoot) {
    throw new Error(`runtime validation directory already exists: ${validationRoot}`);
  }
  await mkdir(validationRoot, { recursive: true });
  await copyFinalPayload(appRoot, validationRoot);

  const manifest = adapter.validateManifest(manifestPath(validationRoot), {
    root: validationRoot,
  });
  return {
    fileCount: manifestEntries(manifest).length,
    manifestSha256: createHash("sha256")
      .update(finalManifestBytes)
      .digest("hex"),
  };
}

async function main(): Promise<void> {
  const [command, ...arguments_] = process.argv.slice(2);
  if (command !== "validate-final" || arguments_.length !== 3) {
    throw new Error(
      `Usage: ${path.basename(process.argv[1] ?? "self-contained-runtime.ts")} validate-final <native-runtime-root> <extracted-App-root> <validation-root>`,
    );
  }
  const result = await validateFinalWindowsSelfContainedRuntime(
    arguments_[0]!,
    arguments_[1]!,
    arguments_[2]!,
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
