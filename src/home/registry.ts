export interface HomeRegistryService {
  id: string;
  name: string;
  kind: "tcp";
}

export const HOME_REGISTRY_PATH = "/.well-known/kepos/services.json";

export interface HomeRegistry {
  schemaVersion: 2;
  revision: 1;
  publisher: {
    displayName: string;
    publisherKey: string;
  };
  services: HomeRegistryService[];
}

export interface CreateHomeRegistryOptions {
  publisherKey: string;
  displayName: string;
  services: HomeRegistryService[];
}

const homeKeyPattern = /^[0-9a-f]{64}$/;
const serviceIdPattern = /^[a-z][a-z0-9-]*$/;

export function createHomeRegistry(
  options: CreateHomeRegistryOptions,
): HomeRegistry {
  if (!homeKeyPattern.test(options.publisherKey)) {
    throw new Error("Publisher key must be 32 bytes of lowercase hex");
  }
  if (
    typeof options.displayName !== "string" ||
    options.displayName.trim().length === 0
  ) {
    throw new Error("publisher display name must be a non-empty string");
  }

  const seenIds = new Set(["home"]);
  const services = options.services.map(
    (service, index): HomeRegistryService => {
      if (!serviceIdPattern.test(service.id)) {
        throw new Error(`service ${index} id must be a lowercase service identifier`);
      }
      if (service.id === "home") {
        throw new Error(`service ${index} uses reserved id home`);
      }
      if (seenIds.has(service.id)) {
        throw new Error(`duplicate service id: ${service.id}`);
      }
      seenIds.add(service.id);
      if (
        typeof service.name !== "string" ||
        service.name.trim().length === 0
      ) {
        throw new Error(`service ${index} name must be a non-empty string`);
      }
      if (service.kind !== "tcp") {
        throw new Error(`service ${index} kind must be tcp`);
      }
      return service;
    },
  );

  return {
    schemaVersion: 2,
    revision: 1,
    publisher: {
      displayName: options.displayName,
      publisherKey: options.publisherKey,
    },
    services: [
      {
        id: "home",
        name: "Home",
        kind: "tcp",
      },
      ...services,
    ],
  };
}
