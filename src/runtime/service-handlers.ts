import type { HomeRegistryService } from "../home/registry.js";

export type ServiceAction = "open" | "copy-command" | "copy-url";
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
  httpUrl?: "open" | "origin";
  icon: ServiceIcon;
  sortGroup: 0 | 1 | 2;
}

export const BUILT_IN_SERVICE_HANDLERS = Object.freeze({
  ente: {
    action: "copy-url",
    httpUrl: "origin",
    icon: "photos",
    sortGroup: 2,
  },
  "ente-storage": {
    action: "copy-url",
    httpUrl: "origin",
    icon: "storage",
    sortGroup: 2,
  },
  forgejo: { action: "open", httpUrl: "open", icon: "git", sortGroup: 0 },
  navidrome: {
    action: "copy-url",
    httpUrl: "origin",
    icon: "music",
    sortGroup: 2,
  },
  ssh: { action: "copy-command", icon: "terminal", sortGroup: 1 },
  woodpecker: {
    action: "open",
    httpUrl: "open",
    icon: "build",
    sortGroup: 0,
  },
} satisfies Readonly<Record<string, BuiltInServiceHandler>>);

export function createServicePresentations(
  services: readonly HomeRegistryService[],
  gatewayPort: number,
  localPorts: ReadonlyMap<string, number> = new Map(),
): ServicePresentation[] {
  return services
    .filter(({ id }) => id !== "home")
    .flatMap((service, registryIndex) => {
      const handler = handlerFor(service.id);
      if (handler === undefined) return [];
      const presentation = createPresentation(
        service,
        handler,
        gatewayPort,
        localPorts.get(service.id),
      );
      if (presentation === undefined) return [];
      return [{
        presentation,
        registryIndex,
        sortGroup: handler.sortGroup,
      }];
    })
    .sort(
      (left, right) =>
        left.sortGroup - right.sortGroup ||
        left.registryIndex - right.registryIndex,
    )
    .map(({ presentation }) => presentation);
}

function handlerFor(id: string): BuiltInServiceHandler | undefined {
  return BUILT_IN_SERVICE_HANDLERS[
    id as keyof typeof BUILT_IN_SERVICE_HANDLERS
  ];
}

function createPresentation(
  service: HomeRegistryService,
  handler: BuiltInServiceHandler,
  gatewayPort: number,
  localPort?: number,
): ServicePresentation | undefined {
  if (handler.httpUrl !== undefined) {
    const url = serviceUrl(
      service.id,
      gatewayPort,
      handler.httpUrl === "open",
    );
    return {
      id: service.id,
      name: service.name,
      access: "http",
      action: handler.action,
      icon: handler.icon,
      url,
      ...(handler.action === "copy-url" ? { copyText: url } : {}),
    };
  }
  if (handler.action !== "copy-command" || localPort === undefined) return;
  return {
    id: service.id,
    name: service.name,
    access: "ssh",
    action: handler.action,
    icon: handler.icon,
    copyText: `ssh -p ${localPort} 127.0.0.1`,
  };
}

function serviceUrl(
  serviceId: string,
  gatewayPort: number,
  trailingSlash: boolean,
): string {
  return `http://${serviceId}.localhost:${gatewayPort}${trailingSlash ? "/" : ""}`;
}
