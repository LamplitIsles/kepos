import { execFile } from "node:child_process";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  rename,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { desktopAppBundle } from "./build-desktop.js";

const bundleIdentifier = "io.github.ttalab.kepos";
const processPattern = "/Kepos.app/Contents/MacOS/Kepos";

export function desktopInstallPath(home: string): string {
  return path.join(home, "Applications", "Kepos.app");
}

export async function replaceDesktopApp(
  source: string,
  target: string,
): Promise<void> {
  await access(source);
  const applications = path.dirname(target);
  await mkdir(applications, { recursive: true });
  const staging = await mkdtemp(path.join(applications, ".kepos-install-"));
  const next = path.join(staging, "Kepos.app");
  const previous = path.join(staging, "Kepos.app.previous");
  let movedPrevious = false;

  try {
    await cp(source, next, { recursive: true });
    try {
      await rename(target, previous);
      movedPrevious = true;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    await rename(next, target);
  } catch (error) {
    if (movedPrevious) await rename(previous, target);
    throw error;
  } finally {
    await rm(staging, { force: true, recursive: true });
  }
}

async function runDesktopInstall(repository: string): Promise<string> {
  const target = desktopInstallPath(os.homedir());
  await quitRunningDesktop();
  await replaceDesktopApp(desktopAppBundle(repository), target);
  await execute("/usr/bin/open", [target]);
  return target;
}

export async function quitRunningDesktop(
  isRunning: () => Promise<boolean> = desktopIsRunning,
  requestQuit: () => Promise<void> = requestDesktopQuit,
): Promise<void> {
  if (!(await isRunning())) return;
  await requestQuit();
  const deadline = Date.now() + 5_000;
  while (await isRunning()) {
    if (Date.now() >= deadline) {
      throw new Error("Kepos did not quit within 5 seconds");
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function requestDesktopQuit(): Promise<void> {
  await execute("/usr/bin/osascript", [
    "-e",
    `if application id "${bundleIdentifier}" is running then tell application id "${bundleIdentifier}" to quit`,
  ]);
}

async function desktopIsRunning(): Promise<boolean> {
  try {
    await execute("/usr/bin/pgrep", ["-f", processPattern]);
    return true;
  } catch (error) {
    if (exitCode(error) === 1) return false;
    throw error;
  }
}

async function execute(command: string, arguments_: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile(command, arguments_, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    "code" in error && error.code === "ENOENT";
}

function exitCode(error: unknown): number | undefined {
  return typeof error === "object" && error !== null &&
      "code" in error && typeof error.code === "number"
    ? error.code
    : undefined;
}

const repository = fileURLToPath(new URL("..", import.meta.url));
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const target = await runDesktopInstall(repository);
  process.stdout.write(`Desktop app installed: ${target}\n`);
}
