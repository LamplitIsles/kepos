import {
  acquirePublisherRuntimeLock,
  acquireSubscriberRuntimeLock,
  type RuntimeLock,
} from "../../../src/runtime/runtime-lock.js";
import { createDesktopController } from "./controller.js";
import type { DesktopSnapshot } from "./protocol.js";
import {
  startDesktopRuntime,
  type DesktopRuntimeConfiguration,
  type StartDesktopPublisherOptions,
  type RunningDesktopRuntime,
  type StartDesktopRuntimeOptions,
  type StartDesktopSubscriberOptions,
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
  bootstrap?: StartDesktopRuntimeOptions["bootstrap"];
  publisher?: Omit<StartDesktopPublisherOptions, "lock">;
  subscriber?: Omit<StartDesktopSubscriberOptions, "lock">;
}

export interface DesktopHostDependencies {
  acquireSingleton(homeDirectory: string): Promise<RuntimeLock>;
  acquirePublisherLock(stateDir: string): Promise<RuntimeLock>;
  acquireSubscriberLock(stateDir: string): Promise<RuntimeLock>;
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
};

export async function startDesktopHost(
  options: StartDesktopHostOptions,
  dependencies: DesktopHostDependencies,
): Promise<RunningDesktopHost> {
  const singleton = await dependencies.acquireSingleton(options.homeDirectory);
  let publisherLock: RuntimeLock | undefined;
  let subscriberLock: RuntimeLock | undefined;
  try {
    if (options.publisher) {
      publisherLock = await dependencies.acquirePublisherLock(
        options.publisher.stateDir,
      );
    }
    if (options.subscriber) {
      subscriberLock = await dependencies.acquireSubscriberLock(
        options.subscriber.stateDir,
      );
    }
  } catch (error) {
    for (const release of [
      () => subscriberLock?.release(),
      () => publisherLock?.release(),
      () => singleton.release(),
    ]) {
      try {
        await release();
      } catch {
        // Preserve the lock acquisition error after trying every prior release.
      }
    }
    throw error;
  }
  let createdWindow: DesktopNativeWindow | undefined;
  let createdWebView: DesktopNativeWebView | undefined;
  let createdTray: DesktopTray | undefined;
  try {
    createdWindow = dependencies.createWindow(720, 620);
    createdWebView = dependencies.createWebView();
    createdTray = dependencies.createTray();
    buildDesktopTray(createdTray);
  } catch (error) {
    await cleanNativeSetup(
      createdWindow,
      createdWebView,
      createdTray,
      publisherLock,
      subscriberLock,
      singleton,
    );
    throw error;
  }
  const mainWindow = createdWindow;
  const mainWebView = createdWebView;
  const mainTray = createdTray;
  let liveTray: DesktopTray | undefined = mainTray;
  let runtime: RunningDesktopRuntime | undefined;
  let runtimeStartTask: Promise<RunningDesktopRuntime> | undefined;
  let cancelPoll: (() => void) | undefined;
  let shutdownPromise: Promise<void> | undefined;
  let mainWindowClosed = false;

  async function openService(url: string): Promise<void> {
    if (shutdownPromise !== undefined) {
      throw new Error("Kepos desktop is stopping");
    }
    mainWebView.openExternal(url);
  }

  function shutdown(): Promise<void> {
    shutdownPromise ??= (async () => {
      let failure: unknown;
      const cleanup = async (
        step: () => void | Promise<void>,
      ): Promise<void> => {
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
      if (runtimeToStop === undefined && runtimeStartTask !== undefined) {
        try {
          runtimeToStop = await runtimeStartTask;
        } catch {
          // The runtime owns release of its subscriber lock on startup failure.
        }
      }
      await cleanup(() => runtimeToStop?.stop());
      runtime = undefined;
      await cleanup(() => {
        mainWebView.destroy();
      });
      await cleanup(() => singleton.release());
      await cleanup(() => {
        if (!mainWindowClosed) mainWindow.close();
      });
      await cleanup(() => dependencies.exit(failure === undefined ? 0 : 1));
      if (failure !== undefined) throw failure;
    })();
    return shutdownPromise;
  }

  async function reconfigure(
    configuration: DesktopRuntimeConfiguration,
  ): Promise<void> {
    if (shutdownPromise !== undefined) {
      throw new Error("Kepos desktop is stopping");
    }
    if (!runtime) throw new Error("Kepos desktop runtime is unavailable");
    await runtime.reconfigure(configuration);
  }

  const controller = createDesktopController({
    initialSnapshot: {
      ...initialSnapshot,
      ...(options.publisher
        ? {
            publisher: {
              phase: "starting" as const,
              activeSubscribers: 0,
              acceptedConnections: 0,
              services: [],
            },
          }
        : {}),
      ...(options.subscriber
        ? {
            subscriber: {
              phase: "starting" as const,
              connection: "connecting" as const,
              services: [],
            },
          }
        : {}),
    },
    send: (message) => mainWebView.postMessage(message),
    openService,
    approvePairing: () => requireRuntime(runtime).approvePairing(),
    cancelPairing: () => requireRuntime(runtime).cancelPairing(),
    createPairingInvitation: () =>
      requireRuntime(runtime).createPairingInvitation(),
    denyPairing: () => requireRuntime(runtime).denyPairing(),
    quit: shutdown,
  });
  try {
    mainTray.on("select", (id) => {
      if (id === trayItemIds.open) {
        mainWindow.show();
        return;
      }
      if (id === trayItemIds.quit) {
        void shutdown().catch((error: unknown) => console.error(error));
      }
    });
    mainWebView.on("message", (message) => {
      void controller.receive(message).catch((error: unknown) => {
        console.error(error);
      });
    });
    mainWindow.content(mainWebView);
    mainWebView.loadHTML(renderDesktopUi());
  } catch (error) {
    await cleanNativeSetup(
      mainWindow,
      mainWebView,
      liveTray,
      publisherLock,
      subscriberLock,
      singleton,
    );
    throw error;
  }
  mainWindow.on("willClose", () => {
    mainWindowClosed = true;
    if (shutdownPromise !== undefined) return;
    void shutdown().catch((error: unknown) => {
      console.error(error);
    });
  });

  let startedRuntime: RunningDesktopRuntime;
  try {
    runtimeStartTask = dependencies.startRuntime({
      ...(options.bootstrap ? { bootstrap: options.bootstrap } : {}),
      ...(options.publisher
        ? {
            publisher: {
              ...options.publisher,
              lock: publisherLock,
            },
          }
        : {}),
      ...(options.subscriber
        ? {
            subscriber: {
              ...options.subscriber,
              lock: subscriberLock,
            },
          }
        : {}),
      onSnapshot: (snapshot) => {
        if (liveTray) updateDesktopTray(liveTray, snapshot);
        controller.publish(snapshot);
      },
    });
    startedRuntime = await runtimeStartTask;
  } catch {
    // startDesktopRuntime publishes a safe failed snapshot and releases every
    // role lock it received. Keep the window open so the user can read it.
    return { reconfigure, shutdown };
  }
  if (shutdownPromise === undefined) {
    runtime = startedRuntime;
    try {
      cancelPoll = dependencies.schedulePoll(() => {
        void runtime?.poll().catch((error: unknown) => console.error(error));
      });
    } catch (error) {
      await shutdown().catch(() => undefined);
      throw error;
    }
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
  mainWindow: DesktopNativeWindow | undefined,
  mainWebView: DesktopNativeWebView | undefined,
  tray: DesktopTray | undefined,
  publisherLock: RuntimeLock | undefined,
  subscriberLock: RuntimeLock | undefined,
  singleton: RuntimeLock,
): Promise<void> {
  const steps = [
    () => tray?.destroy(),
    () => mainWebView?.destroy(),
    () => mainWindow?.close(),
    () => subscriberLock?.release(),
    () => publisherLock?.release(),
    () => singleton.release(),
  ];
  for (const step of steps) {
    try {
      await step();
    } catch {
      // Preserve the native setup error after attempting every cleanup step.
    }
  }
}

export const defaultDesktopHostDependencies = {
  acquireSingleton: acquireDesktopSingleton,
  acquirePublisherLock: acquirePublisherRuntimeLock,
  acquireSubscriberLock: acquireSubscriberRuntimeLock,
  startRuntime: startDesktopRuntime,
};
