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
import { createDesktopDiagnosticSink } from "./diagnostics.js";
import { installDesktopFatalCapture, persistDesktopFatal } from "./fatal.js";
import { defaultDesktopDiagnosticsDirectory } from "./paths.js";
import type { DesktopTray } from "./tray.js";
import { loadDesktopOptions } from "./options.js";
import { desktopLaunchArguments } from "./process.js";
import type { DesktopSnapshot } from "./protocol.js";
import { isHealthySmokeSnapshot } from "./smoke.js";

let startupFatal: { directory: string; runId: string } | undefined;

async function main(): Promise<void> {
  const arguments_ = desktopLaunchArguments(process.argv);
  const defaultHomeDirectory = os.homedir();
  const diagnostics = createDesktopDiagnosticSink({
    directory: defaultDesktopDiagnosticsDirectory({
      homeDirectory: defaultHomeDirectory,
      environment: process.env,
      platform: process.platform,
    }),
    platform: process.platform,
  });
  startupFatal = {
    directory: diagnostics.directory ?? "",
    runId: diagnostics.runId ?? "0000000000000000",
  };
  let latestSnapshot: DesktopSnapshot | undefined;
  let fatalExitCode: number | undefined;
  let shutdownForFatal: (() => Promise<void>) | undefined;
  installDesktopFatalCapture({
    directory: startupFatal.directory,
    runId: startupFatal.runId,
    snapshot: () => latestSnapshot,
    exit: (code) => {
      fatalExitCode ??= code;
      void shutdownForFatal?.();
      Bare.exit(fatalExitCode);
    },
  });
  const smokeTest = arguments_.includes("--smoke-test");
  const fatalTestKind = smokeTest
    ? process.env.KEPOS_DESKTOP_FATAL_TEST
    : undefined;
  if (
    fatalTestKind === "uncaughtException" ||
    fatalTestKind === "unhandledRejection"
  ) {
    const error = new Error(`Bearer native-raw-token seed=${"ab".repeat(32)}`);
    setTimeout(() => {
      if (fatalTestKind === "uncaughtException") throw error;
      Promise.reject(error);
    }, 0);
  }
  const smokeHomeIndex = arguments_.indexOf("--smoke-home");
  if (
    smokeHomeIndex !== -1 &&
    (!arguments_[smokeHomeIndex + 1] ||
      arguments_[smokeHomeIndex + 1].startsWith("--"))
  ) {
    throw new Error("--smoke-home requires a path");
  }
  const smokeHome =
    smokeHomeIndex === -1 ? undefined : arguments_[smokeHomeIndex + 1];
  const launchArguments = arguments_.filter(
    (_, index) =>
      index !== smokeHomeIndex &&
      index !== smokeHomeIndex + 1 &&
      arguments_[index] !== "--smoke-test",
  );
  const homeDirectory = smokeHome ?? defaultHomeDirectory;
  const smokeReadyFile = process.env.KEPOS_WINDOWS_SMOKE_READY_FILE;
  const smokeRenderFile = smokeTest
    ? process.env.KEPOS_WINDOWS_SMOKE_RENDER_FILE
    : undefined;
  const smokeQuitFile = process.env.KEPOS_WINDOWS_SMOKE_QUIT_FILE;
  let smokeFailure = false;
  let smokeSnapshot: DesktopSnapshot | undefined;
  let resolveSmokeRendered: (() => void) | undefined;
  const smokeRendered = smokeRenderFile
    ? new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        resolveSmokeRendered = () => {
          if (timer !== undefined) clearTimeout(timer);
          resolve();
        };
        timer = setTimeout(() => {
          reject(
            new Error(
              "desktop smoke did not receive a rendered-page acknowledgement",
            ),
          );
        }, 40_000);
      })
    : Promise.resolve();
  const running = await startDesktopHost(
    {
      homeDirectory,
      diagnostics,
      loadOptions: async () => {
        const options = await loadDesktopOptions(launchArguments, {
          homeDirectory,
          environment: process.env,
          executablePath: process.execPath,
          platform: process.platform,
        });
        if (smokeTest) {
          options.peer.config.gateway = {
            ...options.peer.config.gateway,
            port: 0,
          };
        }
        return options;
      },
      onSnapshot: (snapshot) => {
        smokeSnapshot = snapshot;
        latestSnapshot = snapshot;
      },
      ...(smokeRenderFile
        ? {
            smokeRenderFile,
            onSmokeRendered: () => resolveSmokeRendered?.(),
          }
        : {}),
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
        Bare.exit(fatalExitCode ?? (smokeFailure ? 1 : code));
      },
    },
  );
  shutdownForFatal = () => running.shutdown();
  if (fatalExitCode !== undefined) {
    await running.shutdown();
    return;
  }
  if (smokeTest) {
    try {
      await smokeRendered;
      if (!isHealthySmokeSnapshot(smokeSnapshot)) {
        throw new Error(
          "desktop smoke did not observe a healthy canonical peer snapshot",
        );
      }
      if (smokeReadyFile) {
        await writeFile(smokeReadyFile, `${JSON.stringify(smokeSnapshot)}\n`);
      }
    } catch (error) {
      smokeFailure = true;
      await recordSmokeError(error);
      await running.shutdown().catch(() => undefined);
      throw error;
    }
  }
  console.log("KEPOS_DESKTOP_READY");
  if (smokeTest) {
    setTimeout(() => void running.shutdown(), 100);
  }
}

async function recordSmokeError(error: unknown): Promise<void> {
  const smokeErrorFile = process.env.KEPOS_WINDOWS_SMOKE_ERROR_FILE;
  if (
    desktopLaunchArguments(process.argv).includes("--smoke-test") &&
    smokeErrorFile
  ) {
    await writeFile(
      smokeErrorFile,
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    ).catch(() => undefined);
  }
}

try {
  await main();
} catch (error) {
  if (startupFatal)
    persistDesktopFatal(
      startupFatal.directory,
      startupFatal.runId,
      "startup",
      error,
    );
  await recordSmokeError(error);
  // Startup errors after diagnostics initialization are caught by the fatal handlers above.
  console.error(error);
  Bare.exit(1);
}
