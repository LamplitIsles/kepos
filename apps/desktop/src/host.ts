import type { SubscriberService } from "../../../src/runtime/subscriber.js";
import {
  acquirePublisherRuntimeLock,
  acquireSubscriberRuntimeLock,
  type RuntimeLock,
} from "../../../src/runtime/runtime-lock.js";
import { createDesktopController } from "./controller.js";
import type { DesktopSnapshot } from "./protocol.js";
import {
  startDesktopRuntime,
  type RunningDesktopRuntime,
  type StartDesktopRuntimeOptions,
} from "./runtime.js";
import { acquireDesktopSingleton } from "./singleton.js";
import { renderDesktopUi } from "./ui.js";

export interface DesktopNativeWindow {
  on(event: "willClose", listener: () => void): this;
  content(view: DesktopNativeWebView): this;
  close(): this;
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
  publisher?: { stateDir: string };
  subscriber?: {
    stateDir: string;
    gatewayPort: number;
    services: SubscriberService[];
  };
}

export interface DesktopHostDependencies {
  acquireSingleton(homeDirectory: string): Promise<RuntimeLock>;
  acquirePublisherLock(stateDir: string): Promise<RuntimeLock>;
  acquireSubscriberLock(stateDir: string): Promise<RuntimeLock>;
  createWindow(width: number, height: number): DesktopNativeWindow;
  createWebView(): DesktopNativeWebView;
  startRuntime(
    options: StartDesktopRuntimeOptions,
  ): Promise<RunningDesktopRuntime>;
  schedulePoll(callback: () => void): () => void;
  exit(code: number): void;
}

export interface RunningDesktopHost {
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
  try {
    createdWindow = dependencies.createWindow(720, 620);
    createdWebView = dependencies.createWebView();
  } catch (error) {
    await cleanNativeSetup(
      createdWindow,
      createdWebView,
      publisherLock,
      subscriberLock,
      singleton,
    );
    throw error;
  }
  const mainWindow = createdWindow;
  const mainWebView = createdWebView;
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
      const cleanup = async (step: () => void | Promise<void>): Promise<void> => {
        try {
          await step();
        } catch (error) {
          failure ??= error;
        }
      };

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
    showHome: async () => undefined,
    quit: shutdown,
  });
  try {
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
      ...(options.publisher
        ? {
            publisher: {
              stateDir: options.publisher.stateDir,
              lock: publisherLock,
            },
          }
        : {}),
      ...(options.subscriber
        ? {
            subscriber: {
              stateDir: options.subscriber.stateDir,
              gatewayPort: options.subscriber.gatewayPort,
              services: options.subscriber.services,
              lock: subscriberLock,
            },
          }
        : {}),
      onSnapshot: (snapshot) => controller.publish(snapshot),
    });
    startedRuntime = await runtimeStartTask;
  } catch {
    // startDesktopRuntime already publishes a safe failed snapshot and releases
    // the subscriber-state lock. Keep the window open so the user can read it.
    return { shutdown };
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

  return { shutdown };
}

async function cleanNativeSetup(
  mainWindow: DesktopNativeWindow | undefined,
  mainWebView: DesktopNativeWebView | undefined,
  publisherLock: RuntimeLock | undefined,
  subscriberLock: RuntimeLock | undefined,
  singleton: RuntimeLock,
): Promise<void> {
  const steps = [
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
