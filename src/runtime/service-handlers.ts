import type { HomeRegistryService } from "../home/registry.js";

export type ServiceAction = "open" | "copy-command" | "copy-url" | "info";
export type ServiceIcon =
  | "build"
  | "git"
  | "music"
  | "photos"
  | "port"
  | "storage"
  | "terminal"
  | "web";

export interface ServicePresentation {
  id: string;
  name: string;
  access: "http" | "ssh" | "tcp";
  action: ServiceAction;
  icon: ServiceIcon;
  url?: string;
  copyText?: string;
}

interface BuiltInServiceHandler {
  action: ServiceAction;
  icon: ServiceIcon;
  sortGroup: 0 | 1 | 2;
}

export const BUILT_IN_SERVICE_HANDLERS = Object.freeze({
  ente: { action: "copy-url", icon: "photos", sortGroup: 2 },
  "ente-storage": { action: "info", icon: "storage", sortGroup: 2 },
  forgejo: { action: "open", icon: "git", sortGroup: 0 },
  navidrome: { action: "copy-url", icon: "music", sortGroup: 2 },
  ssh: { action: "copy-command", icon: "terminal", sortGroup: 1 },
  woodpecker: { action: "open", icon: "build", sortGroup: 0 },
} satisfies Readonly<Record<string, BuiltInServiceHandler>>);

const fallbackHandler: BuiltInServiceHandler = {
  action: "info",
  icon: "port",
  sortGroup: 2,
};

export function createServicePresentations(
  services: readonly HomeRegistryService[],
  gatewayPort: number,
  localPorts: ReadonlyMap<string, number> = new Map(),
): ServicePresentation[] {
  return services
    .filter(({ id }) => id !== "home")
    .map((service, registryIndex) => {
      const handler = handlerFor(service.id);
      return {
        presentation: createPresentation(
          service,
          handler,
          gatewayPort,
          localPorts.get(service.id),
        ),
        registryIndex,
        sortGroup: handler.sortGroup,
      };
    })
    .sort(
      (left, right) =>
        left.sortGroup - right.sortGroup ||
        left.registryIndex - right.registryIndex,
    )
    .map(({ presentation }) => presentation);
}

function handlerFor(id: string): BuiltInServiceHandler {
  return (
    BUILT_IN_SERVICE_HANDLERS[
      id as keyof typeof BUILT_IN_SERVICE_HANDLERS
    ] ?? fallbackHandler
  );
}

function createPresentation(
  service: HomeRegistryService,
  handler: BuiltInServiceHandler,
  gatewayPort: number,
  localPort?: number,
): ServicePresentation {
  if (handler.action === "open") {
    return {
      id: service.id,
      name: service.name,
      access: "http",
      action: handler.action,
      icon: handler.icon,
      url: serviceUrl(service.id, gatewayPort, true),
    };
  }
  if (handler.action === "copy-url") {
    const url = serviceUrl(service.id, gatewayPort, false);
    return {
      id: service.id,
      name: service.name,
      access: "http",
      action: handler.action,
      icon: handler.icon,
      url,
      copyText: url,
    };
  }
  if (handler.action === "copy-command" && localPort !== undefined) {
    return {
      id: service.id,
      name: service.name,
      access: "ssh",
      action: handler.action,
      icon: handler.icon,
      copyText: `ssh -p ${localPort} 127.0.0.1`,
    };
  }
  return {
    id: service.id,
    name: service.name,
    access: handler.action === "copy-command" ? "ssh" : "tcp",
    action: "info",
    icon: handler.icon,
  };
}

function serviceUrl(
  serviceId: string,
  gatewayPort: number,
  trailingSlash: boolean,
): string {
  return `http://${serviceId}.localhost:${gatewayPort}${trailingSlash ? "/" : ""}`;
}
