import b4a from "b4a";

export interface PublisherIdentity {
  seed: string;
}

export interface SubscriberDevice {
  publicKey: string;
  label: string;
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

const keyHexPattern = /^[0-9a-f]{64}$/;
const serviceIdPattern = /^[a-z][a-z0-9-]*$/;
const maximumSubscriberLabelBytes = 128;

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
  const unknownField = Object.keys(value).find(
    (field) => !allowedFields.includes(field),
  );
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

export function parseSubscriberDevice(
  value: unknown,
  field = "subscriber device",
): SubscriberDevice {
  if (!isRecord(value)) {
    throw new Error(`${field} must be an object`);
  }
  rejectUnknownFields(value, ["publicKey", "label"], field);
  const publicKey = parseKeyHex(value.publicKey, `${field}.publicKey`);
  const label = value.label;
  if (
    typeof label !== "string" ||
    label.length === 0 ||
    label.trim() !== label ||
    b4a.byteLength(label, "utf8") > maximumSubscriberLabelBytes ||
    /[\u0000-\u001f\u007f]/u.test(label)
  ) {
    throw new Error(`${field}.label must be a non-empty bounded label`);
  }
  return { publicKey, label };
}

export function parseSubscriberDevices(
  value: unknown,
  field = "subscribers",
): SubscriberDevice[] {
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array`);
  }
  const devices = value.map((entry, index) =>
    parseSubscriberDevice(entry, `${field}[${index}]`),
  );
  const labels = new Set<string>();
  const keys = new Set<string>();
  for (const device of devices) {
    if (labels.has(device.label)) {
      throw new Error(`duplicate subscriber device label: ${device.label}`);
    }
    if (keys.has(device.publicKey)) {
      throw new Error(
        `duplicate subscriber device public key: ${device.publicKey}`,
      );
    }
    labels.add(device.label);
    keys.add(device.publicKey);
  }
  return devices;
}

function parseTargetPort(value: unknown, field = "targetPort"): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > 65_535
  ) {
    throw new Error(`${field} must be an integer from 1 through 65535`);
  }
  return value;
}

export function parsePublisherIdentity(value: unknown): PublisherIdentity {
  if (!isRecord(value)) {
    throw new Error("publisher identity must be an object");
  }
  rejectUnknownFields(value, ["seed"], "publisher identity");

  const seed = parseKeyHex(value.seed, "seed");
  return { seed };
}

export function serializePublisherIdentity(
  identity: PublisherIdentity,
): string {
  return `${JSON.stringify(parsePublisherIdentity(identity), null, 2)}\n`;
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
    throw new Error(
      "requestedLocalPort must be an integer from 0 through 65535",
    );
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

export function parsePublisherService(
  value: unknown,
  field = "publisher service",
): PublisherService {
  if (!isRecord(value)) {
    throw new Error(`${field} must be an object`);
  }
  rejectUnknownFields(
    value,
    ["id", "name", "kind", "targetPort", "allow"],
    field,
  );
  if (typeof value.id !== "string" || !serviceIdPattern.test(value.id)) {
    throw new Error(`${field}.id must be a lowercase service identifier`);
  }
  if (value.id === "home") {
    throw new Error(`${field}.id uses reserved service id home`);
  }
  const kind = value.kind === undefined ? "tcp" : value.kind;
  if (kind !== "tcp" && kind !== "http") {
    throw new Error(`${field}.kind must be tcp or http`);
  }

  return {
    id: value.id,
    name: parseNonEmptyString(value.name, `${field}.name`),
    kind,
    targetPort: parseTargetPort(value.targetPort, `${field}.targetPort`),
    ...(value.allow === undefined
      ? {}
      : { allow: parseServiceAllow(value.allow, `${field}.allow`) }),
  };
}

function parseServiceAllow(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array`);
  }
  return value.map((entry, index) => parseKeyHex(entry, `${field}[${index}]`));
}

export function parsePublisherServices(
  value: unknown,
  field = "services",
): PublisherService[] {
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array`);
  }
  const seenIds = new Set<string>();
  return value.map((entry, index) => {
    const service = parsePublisherService(entry, `${field}[${index}]`);
    if (seenIds.has(service.id)) {
      throw new Error(`duplicate service id: ${service.id}`);
    }
    seenIds.add(service.id);
    return service;
  });
}
