import { appendFile, writeFile } from "node:fs/promises";

import {
  acquirePublisherRuntimeLock,
  acquireSubscriberRuntimeLock,
  type RuntimeLock,
} from "../../../src/runtime/runtime-lock.js";
import { setSubscriberPublisher } from "../../../src/state/subscriber.js";
import { createDesktopController } from "./controller.js";
import type {
  DesktopOptions,
  DesktopSubscriberOptions,
} from "./options.js";
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
  onSnapshot?: (snapshot: DesktopSnapshot) => void;
  smokeRenderFile?: string;
  onSmokeRendered?: (acknowledgement: DesktopSmokeRenderAcknowledgement) => void;
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
  setSubscriberPublisher(
    options: Parameters<typeof setSubscriberPublisher>[0],
  ): Promise<void>;
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
  let startupOptions: DesktopOptions;
  try {
    startupOptions = await options.loadOptions();
  } catch (error) {
    try {
      await singleton.release();
    } catch {
      // Preserve the startup error after attempting singleton release.
    }
    throw error;
  }
  let publisherLock: RuntimeLock | undefined;
  let subscriberLock: RuntimeLock | undefined;
  try {
    if (startupOptions.publisher) {
      publisherLock = await dependencies.acquirePublisherLock(
        startupOptions.publisher.stateDir,
      );
    }
    if (startupOptions.subscriber) {
      subscriberLock = await dependencies.acquireSubscriberLock(
        startupOptions.subscriber.stateDir,
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
          // The runtime owns release of every role lock on startup failure.
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

  let persistedSubscriberPublisherKey: string | undefined;

  async function connectSubscriber(publisherKey: string): Promise<void> {
    const subscriber = startupOptions.subscriber;
    if (!subscriber) throw new Error("subscriber is not configured");
    const setup = subscriber.subscriberSetup;
    if (!setup || setup.configured !== false) return;

    const configuration = (nextSubscriber: DesktopSubscriberOptions) => ({
      ...(startupOptions.bootstrap
        ? { bootstrap: startupOptions.bootstrap }
        : {}),
      ...(startupOptions.publisher
        ? { publisher: startupOptions.publisher }
        : {}),
      subscriber: nextSubscriber,
    });
    const publishRetryableUnconfigured = async (
      error: unknown,
    ): Promise<void> => {
      const retryableSubscriber = {
        ...subscriber,
        subscriberSetup: {
          ...setup,
          error: error instanceof Error ? error.message : String(error),
        },
      };
      startupOptions = {
        ...startupOptions,
        subscriber: retryableSubscriber,
      };
      try {
        await reconfigure(configuration(retryableSubscriber));
      } catch {
        // Preserve the original failure; the retryable options remain active.
      }
    };

    if (persistedSubscriberPublisherKey !== publisherKey) {
      try {
        await dependencies.setSubscriberPublisher({
          stateDir: subscriber.stateDir,
          label: "publisher",
          publisherKey,
        });
      } catch (error) {
        await publishRetryableUnconfigured(error);
        throw error;
      }
      persistedSubscriberPublisherKey = publisherKey;
    }

    const { subscriberSetup: _subscriberSetup, ...configuredSubscriber } =
      subscriber;
    try {
      await reconfigure(configuration(configuredSubscriber));
    } catch (error) {
      await publishRetryableUnconfigured(error);
      throw error;
    }

    startupOptions = {
      ...startupOptions,
      subscriber: configuredSubscriber,
    };
  }

  const controller = createDesktopController({
    initialSnapshot: {
      ...initialSnapshot,
      ...(startupOptions.publisher
        ? {
            publisher: {
              phase: "starting" as const,
              activeSubscribers: 0,
              activeSubscriberKeys: [],
              acceptedConnections: 0,
              services: [],
            },
          }
        : {}),
      ...(startupOptions.subscriber
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
    setSubscriberPublisher: connectSubscriber,
    quit: shutdown,
  });
  const smokeRenderFile = options.smokeRenderFile;
  let smokeRenderRecorded = false;
  const receiveMessage = async (message: string): Promise<void> => {
    if (smokeRenderFile) {
      await appendFile(`${smokeRenderFile}.messages`, `${message}\n`);
      console.error(`Windows smoke page message: ${message}`);
      let acknowledgement: DesktopSmokeRenderAcknowledgement | undefined;
      try {
        acknowledgement = parseDesktopSmokeRenderAcknowledgement(message);
      } catch (error) {
        console.error("Windows smoke acknowledgement parse failed", error);
        // Let malformed or unrelated messages take the normal command path.
      }
      if (acknowledgement !== undefined) {
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
      if (id === trayItemIds.open) {
        mainWindow.show();
        return;
      }
      if (id === trayItemIds.quit) {
        void shutdown().catch((error: unknown) => console.error(error));
      }
    });
    mainWebView.on("message", (message) => {
      void receiveMessage(message).catch((error: unknown) => {
        console.error(error);
      });
    });
    mainWindow.content(mainWebView);
    mainWebView.loadHTML(
      renderDesktopUi({ smokeAcknowledgement: smokeRenderFile !== undefined }),
    );
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
      ...(startupOptions.bootstrap
        ? { bootstrap: startupOptions.bootstrap }
        : {}),
      ...(startupOptions.publisher
        ? {
            publisher: {
              ...startupOptions.publisher,
              lock: publisherLock,
            },
          }
        : {}),
      ...(startupOptions.subscriber
        ? {
            subscriber: {
              ...startupOptions.subscriber,
              lock: subscriberLock,
            },
          }
        : {}),
      onSnapshot: (snapshot) => {
        if (liveTray) updateDesktopTray(liveTray, snapshot);
        controller.publish(snapshot);
        options.onSnapshot?.(snapshot);
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
  setSubscriberPublisher: async (
    options: Parameters<typeof setSubscriberPublisher>[0],
  ) => {
    await setSubscriberPublisher(options);
  },
};
