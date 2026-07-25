import process from "node:process";
import { WebView, Window } from "bare-native";

import {
  defaultDesktopHostDependencies,
  startDesktopHost,
  type DesktopNativeWebView,
  type DesktopNativeWindow,
} from "./host.js";
import { parseDesktopOptions } from "./options.js";
import {
  desktopLaunchArguments,
  terminateDesktopBeforeWindow,
} from "./process.js";

async function main(): Promise<void> {
  const homeDirectory = process.env.HOME;
  if (!homeDirectory) throw new Error("HOME is required to run Kepos desktop");
  const options = parseDesktopOptions(desktopLaunchArguments(process.argv));

  await startDesktopHost(
    { homeDirectory, ...options },
    {
      ...defaultDesktopHostDependencies,
      createWindow: (width, height) =>
        new Window(width, height) as DesktopNativeWindow,
      createWebView: () => new WebView() as DesktopNativeWebView,
      schedulePoll: (callback) => {
        const timer = setInterval(callback, 500);
        return () => clearInterval(timer);
      },
      exit: (code) => Bare.exit(code),
    },
  );
}

try {
  await main();
} catch (error) {
  console.error(error);
  terminateDesktopBeforeWindow(process);
}
