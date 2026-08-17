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

function hasCode(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
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
  platform: NodeJS.Platform = isWindows ? "win32" : "darwin",
): Promise<void> {
  if (platform !== "win32") {
    await rename(sourcePath, destinationPath);
    return;
  }

  // Windows rename does not replace an existing file. Move the old complete
  // file into a private sibling first, then restore it if installing the next
  // complete file fails. The caller's temporary directory owns sourcePath;
  // this helper owns and removes only its backup directory.
  const replacementDirectory = await mkdtemp(
    path.join(path.dirname(destinationPath), ".replace-"),
  );
  const backupPath = path.join(
    replacementDirectory,
    path.basename(destinationPath),
  );
  let movedPrevious = false;
  try {
    try {
      await rename(destinationPath, backupPath);
      movedPrevious = true;
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
    }

    try {
      await rename(sourcePath, destinationPath);
    } catch (error) {
      if (movedPrevious) {
        await rename(backupPath, destinationPath);
      }
      throw error;
    }

    if (movedPrevious) {
      await rm(backupPath, { force: true });
    }
  } finally {
    await rm(replacementDirectory, { force: true, recursive: true });
  }
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
