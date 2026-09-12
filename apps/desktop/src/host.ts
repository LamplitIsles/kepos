import { appendFile, writeFile } from "node:fs/promises";
import process from "node:process";

import {
  createNoopDesktopDiagnosticSink,
  DESKTOP_DIAGNOSTIC_SUMMARY_MAX_BYTES,
  type DesktopDiagnosticSink,
} from "./diagnostics.js";
import {
  createDesktopConfigObservation,
  createDesktopLifecycleObservation,
} from "./diagnostics-contract.js";
import {
  acquirePeerRuntimeLock,
  type RuntimeLock,
} from "../../../src/runtime/runtime-lock.js";
import { createDesktopController } from "./controller.js";
import type { DesktopOptions } from "./options.js";
import type { DesktopSnapshot } from "./protocol.js";
import {
  parseDesktopSmokeRenderAcknowledgement,
  type DesktopSmokeRenderAcknowledgement,
} from "./smoke.js";
import {
  startDesktopRuntime,
  type DesktopRuntimeConfiguration,
  type RunningDesktopRuntime,
  type StartDesktopRuntimeOptions,
} from "./runtime.js";
import { acquireDesktopSingleton } from "./singleton.js";
import { renderDesktopUi } from "./ui.js";
import {
  buildDesktopTray,
  type DesktopTray,
  trayItemIds,
  updateDesktopTray,
} from "./tray.js";

export interface DesktopNativeWindow {
  on(event: "willClose", listener: () => void): this;
  content(view: DesktopNativeWebView): this;
  close(): this;
  show(): this;
}

export interface DesktopNativeWebView {
  on(event: "message", listener: (message: string) => void): this;
  loadHTML(html: string): this;
  openExternal(url: string): this;
  postMessage(message: string): this;
  destroy(): this;
}

export interface StartDesktopHostOptions {
  homeDirectory: string;
  loadOptions: () => Promise<DesktopOptions>;
  diagnostics?: DesktopDiagnosticSink;
  onSnapshot?: (snapshot: DesktopSnapshot) => void;
  smokeRenderFile?: string;
  onSmokeRendered?: (acknowledgement: DesktopSmokeRenderAcknowledgement) => void;
}

export interface DesktopHostDependencies {
  acquireSingleton(homeDirectory: string): Promise<RuntimeLock>;
  acquirePeerLock(stateDir: string): Promise<RuntimeLock>;
  createWindow(width: number, height: number): DesktopNativeWindow;
  createWebView(): DesktopNativeWebView;
  createTray(): DesktopTray;
  startRuntime(
    options: StartDesktopRuntimeOptions,
  ): Promise<RunningDesktopRuntime>;
  schedulePoll(callback: () => void): () => void;
  exit(code: number): void;
}

export interface RunningDesktopHost {
  reconfigure(configuration: DesktopRuntimeConfiguration): Promise<void>;
  shutdown(): Promise<void>;
}

const initialSnapshot: DesktopSnapshot = {
  type: "snapshot",
  appPhase: "starting",
  peer: {
    phase: "starting",
    connections: [],
    services: [],
    bindings: [],
  },
};

export async function startDesktopHost(
  options: StartDesktopHostOptions,
  dependencies: DesktopHostDependencies,
): Promise<RunningDesktopHost> {
  const diagnostics = options.diagnostics ?? createNoopDesktopDiagnosticSink();
  const reportDiagnostic = (
    observation: Parameters<DesktopDiagnosticSink["observe"]>[0],
  ): void => {
    try {
      diagnostics.observe(observation);
    } catch {
      // Diagnostics are best effort and never affect the host.
    }
  };
  const closeDiagnostics = async (): Promise<void> => {
    try {
      await diagnostics.shutdown();
    } catch {
      // Diagnostics are best effort during shutdown too.
    }
  };
  reportDiagnostic(createDesktopLifecycleObservation("starting"));

  let singleton: RuntimeLock;
  try {
    singleton = await dependencies.acquireSingleton(options.homeDirectory);
  } catch (error) {
    await closeDiagnostics();
    throw error;
  }

  let startupOptions: DesktopOptions;
  try {
    startupOptions = await options.loadOptions();
    reportDiagnostic(createDesktopConfigObservation("load", "success"));
  } catch (error) {
    reportDiagnostic(createDesktopConfigObservation("load", "failed", error));
    await singleton.release().catch(() => undefined);
    await closeDiagnostics();
    throw error;
  }

  let peerLock: RuntimeLock;
  try {
    peerLock = await dependencies.acquirePeerLock(startupOptions.peer.stateDir);
  } catch (error) {
    await singleton.release().catch(() => undefined);
    await closeDiagnostics();
    throw error;
  }

  let window: DesktopNativeWindow | undefined;
  let webView: DesktopNativeWebView | undefined;
  let tray: DesktopTray | undefined;
  try {
    window = dependencies.createWindow(720, 620);
    webView = dependencies.createWebView();
    tray = dependencies.createTray();
    buildDesktopTray(tray);
  } catch (error) {
    await cleanNativeSetup(window, webView, tray, peerLock, singleton);
    await closeDiagnostics();
    throw error;
  }

  const mainWindow = window;
  const mainWebView = webView;
  const mainTray = tray;
  let liveTray: DesktopTray | undefined = mainTray;
  let runtime: RunningDesktopRuntime | undefined;
  let runtimeStartTask: Promise<RunningDesktopRuntime> | undefined;
  let cancelPoll: (() => void) | undefined;
  let shutdownPromise: Promise<void> | undefined;
  let mainWindowClosed = false;

  const openService = async (url: string): Promise<void> => {
    if (shutdownPromise !== undefined) throw new Error("Kepos desktop is stopping");
    mainWebView.openExternal(url);
  };

  const shutdown = (): Promise<void> => {
    shutdownPromise ??= (async () => {
      let failure: unknown;
      const cleanup = async (step: () => void | Promise<void>): Promise<void> => {
        try {
          await step();
        } catch (error) {
          failure ??= error;
        }
      };
      const trayToDestroy = liveTray;
      liveTray = undefined;
      await cleanup(() => {
        trayToDestroy?.destroy();
      });
      await cleanup(() => cancelPoll?.());
      cancelPoll = undefined;
      let runtimeToStop = runtime;
      if (!runtimeToStop && runtimeStartTask) {
        try {
          runtimeToStop = await runtimeStartTask;
        } catch {
          // startDesktopPeerRuntime releases the lock on startup failure.
        }
      }
      if (!runtimeToStop) reportDiagnostic(createDesktopLifecycleObservation("stopping"));
      await cleanup(() => runtimeToStop?.stop());
      runtime = undefined;
      if (!runtimeToStop) reportDiagnostic(createDesktopLifecycleObservation("stopped"));
      await cleanup(closeDiagnostics);
      await cleanup(() => {
        mainWebView.destroy();
      });
      await cleanup(() => peerLock.release());
      await cleanup(() => singleton.release());
      await cleanup(() => {
        if (!mainWindowClosed) mainWindow.close();
      });
      await cleanup(() => dependencies.exit(failure === undefined ? 0 : 1));
      if (failure !== undefined) throw failure;
    })();
    return shutdownPromise;
  };

  const reconfigure = async (
    configuration: DesktopRuntimeConfiguration,
  ): Promise<void> => {
    if (shutdownPromise !== undefined) throw new Error("Kepos desktop is stopping");
    if (!runtime) throw new Error("Kepos desktop runtime is unavailable");
    await runtime.reconfigure(configuration);
  };

  const controller = createDesktopController({
    initialSnapshot,
    send: (message) => mainWebView.postMessage(message),
    openService,
    approvePairing: () => requireRuntime(runtime).approvePairing(),
    cancelPairing: () => requireRuntime(runtime).cancelPairing(),
    createPairingInvitation: () => requireRuntime(runtime).createPairingInvitation(),
    denyPairing: () => requireRuntime(runtime).denyPairing(),
    copyDiagnostics: () =>
      diagnostics.createSummary(DESKTOP_DIAGNOSTIC_SUMMARY_MAX_BYTES - 16 * 1024),
    quit: shutdown,
  });

  const smokeRenderFile = options.smokeRenderFile;
  let smokeRenderRecorded = false;
  const receiveMessage = async (message: string): Promise<void> => {
    if (smokeRenderFile) {
      await appendFile(`${smokeRenderFile}.messages`, `${message}\n`);
      let acknowledgement: DesktopSmokeRenderAcknowledgement | undefined;
      try {
        acknowledgement = parseDesktopSmokeRenderAcknowledgement(message);
      } catch {
        // Normal command handling below reports malformed messages.
      }
      if (acknowledgement) {
        if (!smokeRenderRecorded) {
          smokeRenderRecorded = true;
          await writeFile(smokeRenderFile, `${message}\n`);
          options.onSmokeRendered?.(acknowledgement);
        }
        return;
      }
    }
    await controller.receive(message);
  };

  try {
    mainTray.on("select", (id) => {
      if (id === trayItemIds.open) mainWindow.show();
      else if (id === trayItemIds.quit) void shutdown().catch(console.error);
    });
    mainWebView.on("message", (message) => {
      void receiveMessage(message).catch(console.error);
    });
    mainWindow.content(mainWebView);
    mainWebView.loadHTML(
      renderDesktopUi({
        smokeAcknowledgement: smokeRenderFile !== undefined,
        localDeviceName: process.platform === "darwin" ? "mac" : "windows",
      }),
    );
  } catch (error) {
    await cleanNativeSetup(mainWindow, mainWebView, liveTray, peerLock, singleton);
    await closeDiagnostics();
    throw error;
  }
  mainWindow.on("willClose", () => {
    mainWindowClosed = true;
    if (shutdownPromise === undefined) void shutdown().catch(console.error);
  });

  try {
    runtimeStartTask = dependencies.startRuntime({
      peer: { ...startupOptions.peer, lock: peerLock },
      ...(startupOptions.bootstrap ? { bootstrap: startupOptions.bootstrap } : {}),
      onSnapshot: (snapshot) => {
        try {
          diagnostics.updateSnapshot(snapshot);
        } catch {
          // Diagnostics are best effort.
        }
        if (liveTray) updateDesktopTray(liveTray, snapshot);
        controller.publish(snapshot);
        options.onSnapshot?.(snapshot);
      },
      onObservation: reportDiagnostic,
    });
    runtime = await runtimeStartTask;
  } catch {
    // Keep the window available to show the failure and allow shutdown.
    return { reconfigure, shutdown };
  }

  if (shutdownPromise === undefined) {
    cancelPoll = dependencies.schedulePoll(() => {
      void runtime?.poll().catch(console.error);
    });
  }
  return { reconfigure, shutdown };
}

function requireRuntime(
  runtime: RunningDesktopRuntime | undefined,
): RunningDesktopRuntime {
  if (!runtime) throw new Error("Kepos desktop runtime is unavailable");
  return runtime;
}

async function cleanNativeSetup(
  window: DesktopNativeWindow | undefined,
  webView: DesktopNativeWebView | undefined,
  tray: DesktopTray | undefined,
  peerLock: RuntimeLock,
  singleton: RuntimeLock,
): Promise<void> {
  for (const step of [
    () => tray?.destroy(),
    () => webView?.destroy(),
    () => window?.close(),
    () => peerLock.release(),
    () => singleton.release(),
  ]) {
    try {
      await step();
    } catch {
      // Preserve the original setup error after attempting every cleanup.
    }
  }
}

export const defaultDesktopHostDependencies: Omit<DesktopHostDependencies, "createWindow" | "createWebView" | "createTray" | "schedulePoll" | "exit"> = {
  acquireSingleton: acquireDesktopSingleton,
  acquirePeerLock: acquirePeerRuntimeLock,
  startRuntime: startDesktopRuntime,
};
