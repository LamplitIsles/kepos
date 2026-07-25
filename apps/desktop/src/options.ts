import path from "node:path";

import type { SubscriberService } from "../../../src/runtime/subscriber.js";

export interface DesktopOptions {
  stateDir: string;
  gatewayPort: number;
  services: SubscriberService[];
}

export function parseDesktopOptions(arguments_: readonly string[]): DesktopOptions {
  let stateDir: string | undefined;
  const services: SubscriberService[] = [];

  for (let index = 0; index < arguments_.length; index += 1) {
    const option = arguments_[index];
    const value = arguments_[index + 1];
    if (option !== "--state" && option !== "--service") {
      throw new Error(`unknown option: ${option}`);
    }
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${option} requires a value`);
    }
    index += 1;

    if (option === "--state") {
      if (stateDir !== undefined) throw new Error("--state may be set only once");
      stateDir = path.resolve(value);
      continue;
    }
    services.push(parseService(value));
  }

  if (stateDir === undefined) throw new Error("--state is required");
  if (new Set(services.map(({ id }) => id)).size !== services.length) {
    throw new Error("desktop services must have unique ids");
  }

  return { stateDir, gatewayPort: 17_480, services };
}

function parseService(value: string): SubscriberService {
  const separator = value.lastIndexOf(":");
  const id = value.slice(0, separator);
  const localPort = Number(value.slice(separator + 1));
  if (!/^[a-z][a-z0-9-]*$/.test(id)) {
    throw new Error("desktop service id is invalid");
  }
  if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65_535) {
    throw new Error("desktop service port must be an integer from 1 through 65535");
  }
  return { id, localPort };
}
