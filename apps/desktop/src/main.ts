import process from "node:process";
import os from "node:os";
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

async function main(): Promise<void> {
  const homeDirectory = os.homedir();
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
        new Tray({ accessibilityDescription: "Kepos" }) as DesktopTray,
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
  Bare.exit(1);
}
