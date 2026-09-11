import type { HomeRegistryService } from "../home/registry.js";

export type ServiceAction =
  | "open"
  | "copy-command"
  | "copy-url"
  | "copy-endpoint";

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
  access: "http" | "ssh" | "tcp" | "udp";
  action: ServiceAction;
  icon: ServiceIcon;
  url?: string;
  copyText?: string;
}

export interface LocalServiceMapping {
  kind: "tcp" | "udp";
  port?: number;
  /** A Unix endpoint is copied as a named endpoint instead of as a port. */
  endpoint?: string;
}

export interface ServicePresentationInput {
  id: string;
  name: string;
  kind: "tcp" | "http" | "udp";
  /** Access metadata retained when a legacy-compatible registry says tcp. */
  access?: "http" | "tcp";
  available?: boolean;
  error?: string;
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

/**
 * The service catalog is deliberately data-only.  Both shipped clients use
 * this same mapping, while the peer runtime supplies the actual port or Unix
 * endpoint learned from its canonical binding state.
 */
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
      format: (localPort: number) => `http://127.0.0.1:${localPort}/`,
    },
    sortGroup: 0,
  },
  dagger: {
    action: "copy-command",
    icon: "dagger",
    localCommand: {
      access: "tcp",
      format: (localPort: number) =>
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
      format: (localPort: number) => `socks5://127.0.0.1:${localPort}`,
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
      format: (localPort: number) => `ssh -p ${localPort} 127.0.0.1`,
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

const DEFAULT_TCP_SERVICE_HANDLER = Object.freeze({
  action: "copy-endpoint",
  icon: "port",
  sortGroup: 1,
} satisfies BuiltInServiceHandler);

export function createServicePresentations(
  services: readonly HomeRegistryService[],
  gatewayPort: number,
  localPorts: ReadonlyMap<string, number | LocalServiceMapping> = new Map(),
  options: { supportsUdp?: boolean } = {},
): ServicePresentation[] {
  const supportsUdp = options.supportsUdp ?? true;
  return services
    .filter(({ id }) => id !== "home")
    .flatMap((service, registryIndex) => {
      if (service.kind === "udp" && !supportsUdp) return [];
      const presentation = createServicePresentation(
        service,
        gatewayPort,
        localMapping(localPorts.get(service.id)),
        options,
      );
      if (presentation === undefined) return [];
      return [{
        presentation,
        registryIndex,
        sortGroup: handlerFor(service.id, presentationKind(service)).sortGroup,
      }];
    })
    .sort(
      (left, right) =>
        left.sortGroup - right.sortGroup || left.registryIndex - right.registryIndex,
    )
    .map(({ presentation }) => presentation);
}

/** Build one stable action contract for a local or remote catalog entry. */
export function createServicePresentation(
  service: ServicePresentationInput,
  gatewayPort: number,
  mapping?: LocalServiceMapping,
  options: { supportsUdp?: boolean } = {},
): ServicePresentation | undefined {
  if (service.kind === "udp") {
    if (options.supportsUdp === false) return undefined;
    return {
      id: service.id,
      name: service.name,
      access: "udp",
      action: "copy-endpoint",
      icon: "port",
      ...(mapping?.kind === "udp" ? copyMapping(mapping) : {}),
    };
  }
  if (mapping?.kind === "udp") return undefined;

  const handler = handlerFor(service.id, presentationKind(service));
  if (handler.httpUrl !== undefined) {
    const url = serviceUrl(service.id, gatewayPort, handler.httpUrl === "open");
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

  if (mapping?.endpoint !== undefined) {
    return {
      id: service.id,
      name: service.name,
      access: handler.localCommand?.access ?? "tcp",
      action: "copy-endpoint",
      icon: handler.localCommand === undefined ? "port" : handler.icon,
      copyText: mapping.endpoint,
    };
  }

  if (handler.localCommand !== undefined) {
    return {
      id: service.id,
      name: service.name,
      access: handler.localCommand.access,
      action: handler.action,
      icon: handler.icon,
      ...(mapping?.port === undefined
        ? {}
        : handler.action === "open"
          ? { url: handler.localCommand.format(mapping.port) }
          : { copyText: handler.localCommand.format(mapping.port) }),
    };
  }

  return {
    id: service.id,
    name: service.name,
    access: "tcp",
    action: "copy-endpoint",
    icon: "port",
    ...(mapping?.kind === "tcp" ? copyMapping(mapping) : {}),
  };
}

function handlerFor(
  id: string,
  kind: "tcp" | "http" | "udp",
): BuiltInServiceHandler {
  if (Object.prototype.hasOwnProperty.call(BUILT_IN_SERVICE_HANDLERS, id)) {
    return BUILT_IN_SERVICE_HANDLERS[
      id as keyof typeof BUILT_IN_SERVICE_HANDLERS
    ];
  }
  return kind === "http" ? DEFAULT_HTTP_SERVICE_HANDLER : DEFAULT_TCP_SERVICE_HANDLER;
}

function presentationKind(
  service: Pick<ServicePresentationInput, "kind" | "access">,
): "tcp" | "http" | "udp" {
  if (service.kind === "udp") return "udp";
  return service.access === "http" ? "http" : service.kind;
}

function localMapping(
  value: number | LocalServiceMapping | undefined,
): LocalServiceMapping | undefined {
  if (typeof value === "number") return { port: value, kind: "tcp" };
  return value;
}

function copyMapping(mapping: LocalServiceMapping): { copyText: string } | Record<string, never> {
  if (mapping.endpoint !== undefined) return { copyText: mapping.endpoint };
  if (mapping.port !== undefined) return { copyText: `127.0.0.1:${mapping.port}` };
  return {};
}

function serviceUrl(
  serviceId: string,
  gatewayPort: number,
  trailingSlash: boolean,
): string {
  return `http://${serviceId}.localhost:${gatewayPort}${trailingSlash ? "/" : ""}`;
}
