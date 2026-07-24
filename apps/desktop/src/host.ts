import type { SubscriberService } from "../../../src/runtime/subscriber.js";
import {
  acquireSubscriberRuntimeLock,
  type SubscriberRuntimeLock,
} from "../../../src/runtime/subscriber-lock.js";
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
  stateDir: string;
  gatewayPort: number;
  services: SubscriberService[];
}

export interface DesktopHostDependencies {
  acquireSingleton(homeDirectory: string): Promise<SubscriberRuntimeLock>;
  acquireSubscriberLock(stateDir: string): Promise<SubscriberRuntimeLock>;
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
  phase: "starting",
  connection: "connecting",
  services: [],
};

export async function startDesktopHost(
  options: StartDesktopHostOptions,
  dependencies: DesktopHostDependencies,
): Promise<RunningDesktopHost> {
  const singleton = await dependencies.acquireSingleton(options.homeDirectory);
  let subscriberLock: SubscriberRuntimeLock;
  try {
    subscriberLock = await dependencies.acquireSubscriberLock(options.stateDir);
  } catch (error) {
    await singleton.release();
    throw error;
  }
  const mainWindow = dependencies.createWindow(720, 620);
  const mainWebView = dependencies.createWebView();
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
    initialSnapshot,
    send: (message) => mainWebView.postMessage(message),
    openService,
    showHome: async () => undefined,
    quit: shutdown,
  });
  mainWebView.on("message", (message) => {
    void controller.receive(message).catch((error: unknown) => {
      console.error(error);
    });
  });
  mainWindow.on("willClose", () => {
    mainWindowClosed = true;
    if (shutdownPromise !== undefined) return;
    void shutdown().catch((error: unknown) => {
      console.error(error);
    });
  });
  mainWindow.content(mainWebView);
  mainWebView.loadHTML(renderDesktopUi());

  try {
    runtimeStartTask = dependencies.startRuntime({
      stateDir: options.stateDir,
      gatewayPort: options.gatewayPort,
      services: options.services,
      subscriberLock,
      onSnapshot: (snapshot) => controller.publish(snapshot),
    });
    const startedRuntime = await runtimeStartTask;
    if (shutdownPromise === undefined) {
      runtime = startedRuntime;
      cancelPoll = dependencies.schedulePoll(() => {
        void runtime?.poll().catch((error: unknown) => console.error(error));
      });
    }
  } catch {
    // startDesktopRuntime already publishes a safe failed snapshot and releases
    // the subscriber-state lock. Keep the window open so the user can read it.
  }

  return { shutdown };
}

export const defaultDesktopHostDependencies = {
  acquireSingleton: acquireDesktopSingleton,
  acquireSubscriberLock: acquireSubscriberRuntimeLock,
  startRuntime: startDesktopRuntime,
};
