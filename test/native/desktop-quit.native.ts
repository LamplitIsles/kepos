import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { desktopAppBundle } from "../../scripts/build-desktop.js";

const execute = promisify(execFile);
const repository = process.cwd();

test(
  "desktop exits cleanly when AppKit receives an external Quit event",
  { skip: process.platform !== "darwin" || process.arch !== "arm64" },
  async () => {
    const app = desktopAppBundle(repository);
    const executable = path.join(app, "Contents", "MacOS", "Kepos");
    const homeDirectory = await mkdtemp(
      path.join(os.tmpdir(), "kepos-native-quit-"),
    );
    const child = spawn(
      executable,
      ["--publisher-state", path.join(homeDirectory, "publisher")],
      {
        env: { ...process.env, HOME: homeDirectory },
        stdio: ["ignore", "pipe", "inherit"],
      },
    );

    try {
      await waitUntilReady(child);
      await execute("/usr/bin/osascript", [
        "-e",
        `tell application "${app}" to quit`,
      ]);

      assert.deepEqual(await waitForExit(child), {
        code: 0,
        signal: null,
      });
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await waitForExit(child).catch(() => undefined);
      }
      await rm(homeDirectory, { force: true, recursive: true });
    }
  },
);

async function waitUntilReady(child: ChildProcess): Promise<void> {
  const stdout = child.stdout;
  if (!stdout) throw new Error("Kepos stdout is unavailable");
  return await new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => {
      reject(
        new Error("Kepos did not emit KEPOS_DESKTOP_READY within 10 seconds"),
      );
    }, 10_000);
    stdout.setEncoding("utf8");
    stdout.on("data", (chunk: string) => {
      output += chunk;
      if (!output.split(/\r?\n/u).includes("KEPOS_DESKTOP_READY")) return;
      clearTimeout(timeout);
      resolve();
    });
    child.once("exit", () => {
      clearTimeout(timeout);
      reject(new Error("Kepos exited before KEPOS_DESKTOP_READY"));
    });
  });
}

async function waitForExit(
  child: ChildProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Kepos did not exit within 10 seconds"));
    }, 10_000);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
}
