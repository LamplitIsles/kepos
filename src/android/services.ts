import type { HomeRegistry } from "../home/registry.js";
import {
  createServicePresentations,
  type ServicePresentation,
} from "../runtime/service-handlers.js";

export interface AndroidPublisher {
  displayName: string;
  publisherKey: string;
}

export type AndroidService = ServicePresentation;

export interface AndroidRegistrySnapshot {
  publisher: AndroidPublisher;
  services: AndroidService[];
}

export class AndroidRegistryState {
  private current: AndroidRegistrySnapshot | undefined;
  private refreshRequired = true;

  snapshot(): AndroidRegistrySnapshot | undefined {
    return this.current;
  }

  observeConnection(connection: string): void {
    if (connection !== "connected") this.refreshRequired = true;
  }

  shouldRefresh(connection: string): boolean {
    return connection === "connected" && this.refreshRequired;
  }

  accept(snapshot: AndroidRegistrySnapshot): void {
    this.current = snapshot;
    this.refreshRequired = false;
  }

  clear(): void {
    this.current = undefined;
    this.refreshRequired = true;
  }
}

export function createAndroidRegistrySnapshot(
  registry: HomeRegistry,
  gatewayPort: number,
): AndroidRegistrySnapshot {
  return {
    publisher: { ...registry.publisher },
    services: createServicePresentations(registry.services, gatewayPort),
  };
}
