export interface PublisherConfig {
  seed: string;
  allow: string[];
}

export interface SubscriberContact {
  publisherKey: string;
  label: string;
  requestedLocalPort: number;
}

export interface PublisherService {
  id: string;
  name: string;
  kind: "tcp" | "http";
  targetPort: number;
  allow?: string[];
}

export interface PublisherManifest {
  displayName: string;
  publisherConfig: string;
  services: PublisherService[];
}

const keyHexPattern = /^[0-9a-f]{64}$/;
const serviceIdPattern = /^[a-z][a-z0-9-]*$/;
const publisherConfigFilePattern = /^publisher\.json$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseKeyHex(value: unknown, field: string): string {
  if (typeof value !== "string" || !keyHexPattern.test(value)) {
    throw new Error(`${field} must be 32 bytes of lowercase hex`);
  }

  return value;
}

function rejectUnknownFields(
  value: Record<string, unknown>,
  allowedFields: readonly string[],
  subject: string,
): void {
  const unknownField = Object.keys(value).find((field) => !allowedFields.includes(field));
  if (unknownField) {
    throw new Error(`${subject} has unknown field: ${unknownField}`);
  }
}

function parseNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function parseTargetPort(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error("targetPort must be an integer from 1 through 65535");
  }
  return value;
}

function parsePublisherConfigFile(value: unknown, field: string): string {
  if (typeof value !== "string" || !publisherConfigFilePattern.test(value)) {
    throw new Error(`${field} must be a safe *.publisher.json filename`);
  }
  return value;
}

export function parsePublisherConfig(value: unknown): PublisherConfig {
  if (!isRecord(value)) {
    throw new Error("publisher config must be an object");
  }
  rejectUnknownFields(value, ["seed", "allow"], "publisher config");

  const seed = parseKeyHex(value.seed, "seed");
  if (!Array.isArray(value.allow)) {
    throw new Error("allow must be an array, including for deny-all");
  }

  const allow = value.allow.map((entry, index) => parseKeyHex(entry, `allow[${index}]`));
  return { seed, allow };
}

export function serializePublisherConfig(config: PublisherConfig): string {
  return `${JSON.stringify(parsePublisherConfig(config), null, 2)}\n`;
}

export function parseSubscriberContact(value: unknown): SubscriberContact {
  if (!isRecord(value)) {
    throw new Error("subscriber contact must be an object");
  }
  rejectUnknownFields(
    value,
    ["publisherKey", "label", "requestedLocalPort"],
    "subscriber contact",
  );

  const publisherKey = parseKeyHex(value.publisherKey, "publisherKey");
  if (typeof value.label !== "string" || value.label.trim().length === 0) {
    throw new Error("label must be a non-empty string");
  }
  if (
    typeof value.requestedLocalPort !== "number" ||
    !Number.isInteger(value.requestedLocalPort) ||
    value.requestedLocalPort < 0 ||
    value.requestedLocalPort > 65_535
  ) {
    throw new Error("requestedLocalPort must be an integer from 0 through 65535");
  }

  return {
    publisherKey,
    label: value.label,
    requestedLocalPort: value.requestedLocalPort,
  };
}

export function serializeSubscriberContact(contact: SubscriberContact): string {
  return `${JSON.stringify(parseSubscriberContact(contact), null, 2)}\n`;
}

export function parsePublisherManifest(value: unknown): PublisherManifest {
  if (!isRecord(value)) {
    throw new Error("publisher manifest must be an object");
  }
  rejectUnknownFields(
    value,
    ["displayName", "publisherConfig", "services"],
    "publisher manifest",
  );

  const displayName = parseNonEmptyString(value.displayName, "displayName");
  const publisherConfig = parsePublisherConfigFile(
    value.publisherConfig,
    "publisherConfig",
  );
  if (!Array.isArray(value.services)) {
    throw new Error("services must be an array");
  }

  const seenIds = new Set<string>();
  const services = value.services.map((entry, index): PublisherService => {
    if (!isRecord(entry)) {
      throw new Error(`services[${index}] must be an object`);
    }
    rejectUnknownFields(
      entry,
      ["id", "name", "kind", "targetPort", "allow"],
      `services[${index}]`,
    );

    if (typeof entry.id !== "string" || !serviceIdPattern.test(entry.id)) {
      throw new Error(`services[${index}].id must be a lowercase service identifier`);
    }
    if (entry.id === "home") {
      throw new Error(`services[${index}].id uses reserved service id home`);
    }
    if (seenIds.has(entry.id)) {
      throw new Error(`duplicate service id: ${entry.id}`);
    }
    seenIds.add(entry.id);

    const kind = entry.kind === undefined ? "tcp" : entry.kind;
    if (kind !== "tcp" && kind !== "http") {
      throw new Error(`services[${index}].kind must be tcp or http`);
    }

    return {
      id: entry.id,
      name: parseNonEmptyString(entry.name, `services[${index}].name`),
      kind,
      targetPort: parseTargetPort(entry.targetPort),
      ...(entry.allow === undefined
        ? {}
        : {
            allow: parseServiceAllow(
              entry.allow,
              `services[${index}].allow`,
            ),
          }),
    };
  });

  return { displayName, publisherConfig, services };
}

function parseServiceAllow(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array`);
  }
  return value.map((entry, index) =>
    parseKeyHex(entry, `${field}[${index}]`),
  );
}

export function serializePublisherManifest(manifest: PublisherManifest): string {
  return `${JSON.stringify(parsePublisherManifest(manifest), null, 2)}\n`;
}
