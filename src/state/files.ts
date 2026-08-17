import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { isWindows } from "which-runtime";

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function requireOwnerOnly(mode: number, subject: string): void {
  if (!isWindows && (mode & 0o777) !== 0o600) {
    throw new Error(`${subject} must have owner-only permissions`);
  }
}

export async function validateStateDirectory(
  stateDir: string,
  expectedFileNames: readonly string[],
): Promise<void> {
  const directory = await lstat(stateDir);
  if (!directory.isDirectory() || directory.isSymbolicLink()) {
    throw new Error(`state path must be a regular directory: ${stateDir}`);
  }
  if (!isWindows && (directory.mode & 0o777) !== 0o700) {
    throw new Error(`state directory must have owner-only permissions: ${stateDir}`);
  }

  const actualNames = (await readdir(stateDir)).sort();
  const expectedNames = [...expectedFileNames].sort();
  if (
    actualNames.length !== expectedNames.length ||
    actualNames.some((name, index) => name !== expectedNames[index])
  ) {
    throw new Error(`partial or invalid state in ${stateDir}`);
  }

  for (const name of expectedNames) {
    const filePath = path.join(stateDir, name);
    const file = await lstat(filePath);
    if (!file.isFile() || file.isSymbolicLink()) {
      throw new Error(`state entry must be a regular file: ${filePath}`);
    }
    requireOwnerOnly(file.mode, `state file ${filePath}`);
  }
}

export async function readStateJson(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`invalid state file ${filePath}`, { cause: error });
  }
}

export async function replaceFileAtomically(
  sourcePath: string,
  destinationPath: string,
): Promise<void> {
  // Node delegates rename to libuv. On Windows libuv uses
  // MoveFileExW(..., MOVEFILE_REPLACE_EXISTING), so this single operation
  // keeps the destination at either the old or the new complete file. Do not
  // move the destination aside first: that creates a window with no final
  // path and makes failure cleanup unsafe.
  await rename(sourcePath, destinationPath);
}

export async function writeStateDirectoryAtomically(
  stateDir: string,
  files: ReadonlyMap<string, string>,
): Promise<void> {
  const parentDir = path.dirname(stateDir);
  await mkdir(parentDir, { recursive: true, mode: 0o700 });
  const temporaryDir = await mkdtemp(`${stateDir}.tmp-`);
  await chmod(temporaryDir, 0o700);

  try {
    for (const [name, contents] of files) {
      await writeFile(path.join(temporaryDir, name), contents, { mode: 0o600 });
    }
    await validateStateDirectory(temporaryDir, [...files.keys()]);
    await rename(temporaryDir, stateDir);
  } catch (error) {
    await rm(temporaryDir, { recursive: true, force: true });
    throw error;
  }
}

export async function writeStateFileAtomically(
  stateDir: string,
  fileName: string,
  contents: string,
): Promise<string> {
  const temporaryDir = await mkdtemp(path.join(stateDir, ".write-"));
  const temporaryPath = path.join(temporaryDir, fileName);
  const finalPath = path.join(stateDir, fileName);
  try {
    await writeFile(temporaryPath, contents, { mode: 0o600 });
    await replaceFileAtomically(temporaryPath, finalPath);
    return finalPath;
  } finally {
    await rm(temporaryDir, { recursive: true, force: true });
  }
}
