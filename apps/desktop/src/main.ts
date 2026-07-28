import process from "node:process";
import { Tray, WebView, Window } from "bare-native";

import {
  defaultDesktopHostDependencies,
  startDesktopHost,
  type DesktopNativeWebView,
  type DesktopNativeWindow,
} from "./host.js";
import type { DesktopTray } from "./tray.js";
import { loadDesktopOptions } from "./options.js";
import {
  desktopLaunchArguments,
  terminateDesktopBeforeWindow,
} from "./process.js";

async function main(): Promise<void> {
  const homeDirectory = process.env.HOME;
  if (!homeDirectory) throw new Error("HOME is required to run Kepos desktop");
  const options = await loadDesktopOptions(
    desktopLaunchArguments(process.argv),
    {
      homeDirectory,
      environment: process.env,
    },
  );

  await startDesktopHost(
    { homeDirectory, ...options },
    {
      ...defaultDesktopHostDependencies,
      createWindow: (width, height) =>
        new Window(width, height, {
          hidesOnClose: true,
        }) as DesktopNativeWindow,
      createWebView: () => new WebView() as DesktopNativeWebView,
      createTray: () =>
        new Tray({
          systemImageName: "network",
          accessibilityDescription: "Kepos",
        }) as DesktopTray,
      schedulePoll: (callback) => {
        const timer = setInterval(callback, 500);
        return () => clearInterval(timer);
      },
      exit: (code) => Bare.exit(code),
    },
  );
  console.log("KEPOS_DESKTOP_READY");
}

try {
  await main();
} catch (error) {
  console.error(error);
  terminateDesktopBeforeWindow(process);
}
