import process from "node:process";
import os from "node:os";
import { writeFile } from "node:fs/promises";
import { Tray, WebView, Window } from "bare-native";

import {
  defaultDesktopHostDependencies,
  startDesktopHost,
  type DesktopNativeWebView,
  type DesktopNativeWindow,
} from "./host.js";
import type { DesktopTray } from "./tray.js";
import { loadDesktopOptions } from "./options.js";
import { desktopLaunchArguments } from "./process.js";
import type { DesktopSnapshot } from "./protocol.js";
import { isHealthySmokeSnapshot } from "./smoke.js";

async function main(): Promise<void> {
  const arguments_ = desktopLaunchArguments(process.argv);
  const smokeTest = arguments_.includes("--smoke-test");
  const smokeHomeIndex = arguments_.indexOf("--smoke-home");
  if (
    smokeHomeIndex !== -1 &&
    (!arguments_[smokeHomeIndex + 1] ||
      arguments_[smokeHomeIndex + 1].startsWith("--"))
  ) {
    throw new Error("--smoke-home requires a path");
  }
  const smokeHome = smokeHomeIndex === -1 ? undefined : arguments_[smokeHomeIndex + 1];
  const launchArguments = arguments_.filter(
    (_, index) =>
      index !== smokeHomeIndex &&
      index !== smokeHomeIndex + 1 &&
      arguments_[index] !== "--smoke-test",
  );
  const homeDirectory = smokeHome ?? os.homedir();
  const options = await loadDesktopOptions(launchArguments, {
    homeDirectory,
    environment: process.env,
  });

  const smokeReadyFile = process.env.KEPOS_WINDOWS_SMOKE_READY_FILE;
  const smokeQuitFile = process.env.KEPOS_WINDOWS_SMOKE_QUIT_FILE;
  let smokeSnapshot: DesktopSnapshot | undefined;
  const running = await startDesktopHost(
    {
      homeDirectory,
      ...options,
      onSnapshot: (snapshot) => {
        smokeSnapshot = snapshot;
      },
    },
    {
      ...defaultDesktopHostDependencies,
      createWindow: (width, height) =>
        new Window(width, height, {
          hidesOnClose: true,
          title: "Kepos",
        }) as DesktopNativeWindow,
      createWebView: () => new WebView() as DesktopNativeWebView,
      createTray: () =>
        new Tray({ accessibilityDescription: "Kepos" }) as DesktopTray,
      schedulePoll: (callback) => {
        const timer = setInterval(callback, 500);
        return () => clearInterval(timer);
      },
      exit: async (code) => {
        if (smokeQuitFile) {
          try {
            await writeFile(smokeQuitFile, "KEPOS_DESKTOP_QUIT\n");
          } catch {
            // The process exit code remains the authoritative smoke result.
          }
        }
        Bare.exit(code);
      },
    },
  );
  if (smokeTest) {
    try {
      if (!isHealthySmokeSnapshot(smokeSnapshot)) {
        throw new Error("desktop smoke did not observe a healthy role/runtime snapshot");
      }
      if (smokeReadyFile) {
        await writeFile(smokeReadyFile, `${JSON.stringify(smokeSnapshot)}\n`);
      }
    } catch (error) {
      await running.shutdown().catch(() => undefined);
      throw error;
    }
  }
  console.log("KEPOS_DESKTOP_READY");
  if (smokeTest) {
    setTimeout(() => void running.shutdown(), 100);
  }
}

try {
  await main();
} catch (error) {
  console.error(error);
  Bare.exit(1);
}
