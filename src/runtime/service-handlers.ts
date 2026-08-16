import type { HomeRegistryService } from "../home/registry.js";

export type ServiceAction = "open" | "copy-command" | "copy-url";
export type ServiceIcon =
  | "book"
  | "build"
  | "dashboard"
  | "dagger"
  | "git"
  | "music"
  | "photos"
  | "port"
  | "proxy"
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
  localCommand?: {
    access: "http" | "ssh" | "tcp";
    format(localPort: number): string;
  };
  sortGroup: 0 | 1 | 2;
}

export const BUILT_IN_SERVICE_HANDLERS = Object.freeze({
  bookorbit: {
    action: "open",
    httpUrl: "open",
    icon: "book",
    sortGroup: 0,
  },
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
  dsh: {
    action: "open",
    icon: "terminal",
    localCommand: {
      access: "http",
      format: (localPort) => `http://127.0.0.1:${localPort}/`,
    },
    sortGroup: 0,
  },
  dagger: {
    action: "copy-command",
    icon: "dagger",
    localCommand: {
      access: "tcp",
      format: (localPort) =>
        `export _EXPERIMENTAL_DAGGER_RUNNER_HOST=tcp://127.0.0.1:${localPort}`,
    },
    sortGroup: 1,
  },
  forgejo: { action: "open", httpUrl: "open", icon: "git", sortGroup: 0 },
  mihomo: {
    action: "copy-url",
    icon: "proxy",
    localCommand: {
      access: "tcp",
      format: (localPort) => `socks5://127.0.0.1:${localPort}`,
    },
    sortGroup: 1,
  },
  "mihomo-dashboard": {
    action: "open",
    httpUrl: "open",
    icon: "dashboard",
    sortGroup: 0,
  },
  navidrome: {
    action: "copy-url",
    httpUrl: "origin",
    icon: "music",
    sortGroup: 2,
  },
  ssh: {
    action: "copy-command",
    icon: "terminal",
    localCommand: {
      access: "ssh",
      format: (localPort) => `ssh -p ${localPort} 127.0.0.1`,
    },
    sortGroup: 1,
  },
  woodpecker: {
    action: "open",
    httpUrl: "open",
    icon: "build",
    sortGroup: 0,
  },
} satisfies Readonly<Record<string, BuiltInServiceHandler>>);

const DEFAULT_HTTP_SERVICE_HANDLER = Object.freeze({
  action: "open",
  httpUrl: "open",
  icon: "web",
  sortGroup: 0,
} satisfies BuiltInServiceHandler);

export function createServicePresentations(
  services: readonly HomeRegistryService[],
  gatewayPort: number,
  localPorts: ReadonlyMap<string, number> = new Map(),
): ServicePresentation[] {
  return services
    .filter(({ id }) => id !== "home")
    .flatMap((service, registryIndex) => {
      const handler = handlerFor(service.id);
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

function handlerFor(id: string): BuiltInServiceHandler {
  if (!Object.prototype.hasOwnProperty.call(BUILT_IN_SERVICE_HANDLERS, id)) {
    return DEFAULT_HTTP_SERVICE_HANDLER;
  }
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
  if (handler.localCommand === undefined || localPort === undefined) return;
  return {
    id: service.id,
    name: service.name,
    access: handler.localCommand.access,
    action: handler.action,
    icon: handler.icon,
    ...(handler.action === "open"
      ? { url: handler.localCommand.format(localPort) }
      : { copyText: handler.localCommand.format(localPort) }),
  };
}

function serviceUrl(
  serviceId: string,
  gatewayPort: number,
  trailingSlash: boolean,
): string {
  return `http://${serviceId}.localhost:${gatewayPort}${trailingSlash ? "/" : ""}`;
}
