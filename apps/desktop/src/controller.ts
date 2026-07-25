import {
  parseDesktopCommand,
  serializeDesktopSnapshot,
  type DesktopSnapshot,
} from "./protocol.js";

export interface DesktopController {
  publish(snapshot: DesktopSnapshot): void;
  receive(message: string): Promise<void>;
}

export interface DesktopControllerOptions {
  initialSnapshot: DesktopSnapshot;
  send(message: string): void;
  openService(url: string): Promise<void>;
  showHome(): Promise<void>;
  quit(): Promise<void>;
}

export function createDesktopController(
  options: DesktopControllerOptions,
): DesktopController {
  let current = options.initialSnapshot;
  let currentSerialized = serializeDesktopSnapshot(current);
  let lastSent: string | undefined;
  let ready = false;
  let quitStarted = false;
  let commandTask: Promise<void> = Promise.resolve();

  function sendCurrent(): void {
    if (!ready || currentSerialized === lastSent) return;
    options.send(currentSerialized);
    lastSent = currentSerialized;
  }

  async function handle(message: string): Promise<void> {
    const command = parseDesktopCommand(message);
    if (command.type === "ready") {
      ready = true;
      sendCurrent();
      return;
    }
    if (command.type === "showHome") {
      await options.showHome();
      return;
    }
    if (command.type === "quit") {
      if (quitStarted) return;
      quitStarted = true;
      await options.quit();
      return;
    }

    const service = current.subscriber?.services.find(
      ({ id }) => id === command.serviceId,
    );
    if (
      service?.action !== "open" ||
      !service.available ||
      service.url === undefined
    ) {
      throw new Error(
        `${command.serviceId} is not an available HTTP service`,
      );
    }
    await options.openService(service.url);
  }

  return {
    publish(snapshot): void {
      current = snapshot;
      currentSerialized = serializeDesktopSnapshot(current);
      sendCurrent();
    },
    receive(message): Promise<void> {
      const task = commandTask.then(() => handle(message));
      commandTask = task.catch(() => undefined);
      return task;
    },
  };
}
