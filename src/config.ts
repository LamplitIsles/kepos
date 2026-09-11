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

export interface LocalPublisherServiceSource {
  localPort: number;
}

export interface UpstreamPublisherServiceSource {
  publisherKey: string;
  serviceId: string;
}

export type PublisherServiceSource =
  | LocalPublisherServiceSource
  | UpstreamPublisherServiceSource;

export interface PublisherService {
  id: string;
  name: string;
  kind: "tcp" | "http" | "udp";
  source: PublisherServiceSource;
  allow?: string[];
  maxPublisherToSubscriberBps?: number;
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
      throw new Error(`duplicate subscriber device public key: ${device.publicKey}`);
    }
    labels.add(device.label);
    keys.add(device.publicKey);
  }
  return devices;
}

function parseLocalPort(value: unknown, field = "localPort"): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${field} must be an integer from 1 through 65535`);
  }
  return value;
}

function parseUpstreamServiceId(value: unknown, field: string): string {
  if (typeof value !== "string" || !serviceIdPattern.test(value)) {
    throw new Error(`${field} must be a lowercase service identifier`);
  }
  return value;
}

function parsePublisherServiceSource(
  value: unknown,
  field: string,
): PublisherServiceSource {
  if (!isRecord(value)) {
    throw new Error(`${field} must be an object`);
  }
  const hasLocalPort = Object.prototype.hasOwnProperty.call(value, "localPort");
  const hasPublisherKey = Object.prototype.hasOwnProperty.call(value, "publisherKey");
  const hasServiceId = Object.prototype.hasOwnProperty.call(value, "serviceId");
  if (hasLocalPort && (hasPublisherKey || hasServiceId)) {
    throw new Error(`${field} must describe either a local or upstream source`);
  }
  if (!hasLocalPort && !hasPublisherKey && !hasServiceId) {
    throw new Error(`${field} must describe a local or upstream source`);
  }
  if (hasLocalPort) {
    rejectUnknownFields(value, ["localPort"], field);
    return { localPort: parseLocalPort(value.localPort, `${field}.localPort`) };
  }
  rejectUnknownFields(value, ["publisherKey", "serviceId"], field);
  if (!hasPublisherKey || !hasServiceId) {
    throw new Error(`${field} upstream source requires publisherKey and serviceId`);
  }
  return {
    publisherKey: parseKeyHex(value.publisherKey, `${field}.publisherKey`),
    serviceId: parseUpstreamServiceId(value.serviceId, `${field}.serviceId`),
  };
}

function parseMaxPublisherToSubscriberBps(
  value: unknown,
  field = "maxPublisherToSubscriberBps",
): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return value as number;
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

export function parsePublisherService(
  value: unknown,
  field = "publisher service",
): PublisherService {
  if (!isRecord(value)) {
    throw new Error(`${field} must be an object`);
  }
  rejectUnknownFields(
    value,
    [
      "id",
      "name",
      "kind",
      "source",
      "allow",
      "maxPublisherToSubscriberBps",
    ],
    field,
  );
  if (typeof value.id !== "string" || !serviceIdPattern.test(value.id)) {
    throw new Error(`${field}.id must be a lowercase service identifier`);
  }
  if (value.id === "home") {
    throw new Error(`${field}.id uses reserved service id home`);
  }
  const kind = value.kind === undefined ? "tcp" : value.kind;
  if (kind !== "tcp" && kind !== "http" && kind !== "udp") {
    throw new Error(`${field}.kind must be tcp or http or udp`);
  }

  return {
    id: value.id,
    name: parseNonEmptyString(value.name, `${field}.name`),
    kind,
    source: parsePublisherServiceSource(value.source, `${field}.source`),
    ...(value.allow === undefined
      ? {}
      : { allow: parseServiceAllow(value.allow, `${field}.allow`) }),
    ...(value.maxPublisherToSubscriberBps === undefined
      ? {}
      : {
          maxPublisherToSubscriberBps: parseMaxPublisherToSubscriberBps(
            value.maxPublisherToSubscriberBps,
            `${field}.maxPublisherToSubscriberBps`,
          ),
        }),
  };
}

function parseServiceAllow(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array`);
  }
  return value.map((entry, index) =>
    parseKeyHex(entry, `${field}[${index}]`),
  );
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

/**
 * The configuration model used by the peer runtime.
 *
 * The publisher/subscriber types above are retained only by the legacy wire
 * adapters.  TOML readers and new runtime callers use these peer-oriented
 * types instead; a peer has one identity and a connection direction is a
 * property of a configured relationship, never of that identity.
 */
export type PeerConnectionDirection = "dial" | "accept";

export interface PeerDefinition {
  label: string;
  publicKey: string;
  connection: PeerConnectionDirection;
}

export interface PeerLocalPortEndpoint {
  localPort: number;
}

export interface PeerUnixSocketEndpoint {
  unixSocket: string;
}

export type PeerListenEndpoint =
  | PeerLocalPortEndpoint
  | PeerUnixSocketEndpoint;

export interface PeerUpstreamServiceSource {
  peer: string;
  service: string;
}

export type PeerServiceSource =
  | PeerLocalPortEndpoint
  | PeerUnixSocketEndpoint
  | PeerUpstreamServiceSource;

export interface PeerService {
  id: string;
  name: string;
  kind: "tcp" | "http" | "udp";
  source: PeerServiceSource;
  allow: string[];
  maxPublisherToSubscriberBps?: number;
}

export interface PeerBinding {
  peer: string;
  service: string;
  listen: PeerListenEndpoint;
}

export interface PeerNetworkConfig {
  bootstrap?: import("./mux/hyperdht.js").DhtAddress[];
  route?: import("./mux/route.js").Route;
}

export interface PeerGatewayConfig {
  port?: number;
  host?: string;
  domain?: string;
}

export interface PeerConfig {
  network?: PeerNetworkConfig;
  gateway?: PeerGatewayConfig;
  peers: PeerDefinition[];
  services: PeerService[];
  bindings: PeerBinding[];
}

const peerLabelMaximumBytes = 128;

function parsePeerReference(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) {
    throw new Error(`${field} must be a non-empty peer label or public key`);
  }
  if (b4a.byteLength(value, "utf8") > peerLabelMaximumBytes) {
    throw new Error(`${field} exceeds ${peerLabelMaximumBytes} bytes`);
  }
  return value;
}

function parseAbsoluteUnixSocket(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !value.startsWith("/") ||
    value.includes("\u0000") ||
    value.length > 103
  ) {
    throw new Error(`${field} must be an absolute Unix socket path of at most 103 characters`);
  }
  return value;
}

function parsePeerPort(value: unknown, field: string, allowZero: boolean): number {
  const minimum = allowZero ? 0 : 1;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > 65_535
  ) {
    throw new Error(`${field} must be an integer from ${minimum} through 65535`);
  }
  return value;
}

function parsePeerEndpoint(
  value: unknown,
  field: string,
  allowZero: boolean,
): PeerListenEndpoint {
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  const hasPort = Object.prototype.hasOwnProperty.call(value, "localPort");
  const hasSocket = Object.prototype.hasOwnProperty.call(value, "unixSocket");
  if (hasPort === hasSocket) {
    throw new Error(`${field} must describe exactly one localPort or unixSocket endpoint`);
  }
  if (hasPort) {
    rejectUnknownFields(value, ["localPort"], field);
    return { localPort: parsePeerPort(value.localPort, `${field}.localPort`, allowZero) };
  }
  rejectUnknownFields(value, ["unixSocket"], field);
  return { unixSocket: parseAbsoluteUnixSocket(value.unixSocket, `${field}.unixSocket`) };
}

function parsePeerServiceSource(
  value: unknown,
  field: string,
): PeerServiceSource {
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  const endpointKeys = ["localPort", "unixSocket"] as const;
  const hasLocalPort = Object.prototype.hasOwnProperty.call(value, "localPort");
  const hasUnixSocket = Object.prototype.hasOwnProperty.call(value, "unixSocket");
  const hasPeer = Object.prototype.hasOwnProperty.call(value, "peer");
  const hasService = Object.prototype.hasOwnProperty.call(value, "service");
  const endpointCount = Number(hasLocalPort) + Number(hasUnixSocket);
  if (endpointCount + Number(hasPeer || hasService) === 0) {
    throw new Error(`${field} must describe a local port, Unix socket, or peer service`);
  }
  if (endpointCount > 0 && (hasPeer || hasService)) {
    throw new Error(`${field} must describe exactly one source variant`);
  }
  if (hasLocalPort && hasUnixSocket) {
    throw new Error(`${field} must describe exactly one local endpoint`);
  }
  if (hasLocalPort) {
    rejectUnknownFields(value, endpointKeys, field);
    return { localPort: parsePeerPort(value.localPort, `${field}.localPort`, false) };
  }
  if (hasUnixSocket) {
    rejectUnknownFields(value, endpointKeys, field);
    return { unixSocket: parseAbsoluteUnixSocket(value.unixSocket, `${field}.unixSocket`) };
  }
  rejectUnknownFields(value, ["peer", "service"], field);
  if (!hasPeer || !hasService) {
    throw new Error(`${field} peer source requires peer and service`);
  }
  return {
    peer: parsePeerReference(value.peer, `${field}.peer`),
    service: parseServiceIdentifier(value.service, `${field}.service`),
  };
}

function parseServiceIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string" || !serviceIdPattern.test(value) || value === "home") {
    throw new Error(`${field} must be a non-reserved lowercase service identifier`);
  }
  return value;
}

function parsePeerAllow(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  const seen = new Set<string>();
  return value.map((entry, index) => {
    const key = parseKeyHex(entry, `${field}[${index}]`);
    if (seen.has(key)) throw new Error(`duplicate peer service grant: ${key}`);
    seen.add(key);
    return key;
  });
}

function parsePeerDefinition(value: unknown, field: string): PeerDefinition {
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  rejectUnknownFields(value, ["label", "publicKey", "connection"], field);
  const label = value.label;
  if (
    typeof label !== "string" ||
    label.length === 0 ||
    label.trim() !== label ||
    b4a.byteLength(label, "utf8") > peerLabelMaximumBytes ||
    /[\u0000-\u001f\u007f]/u.test(label)
  ) {
    throw new Error(`${field}.label must be a non-empty bounded label`);
  }
  const publicKey = parseKeyHex(value.publicKey, `${field}.publicKey`);
  if (value.connection !== "dial" && value.connection !== "accept") {
    throw new Error(`${field}.connection must be dial or accept`);
  }
  return { label, publicKey, connection: value.connection };
}

function parsePeerService(value: unknown, field: string): PeerService {
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  rejectUnknownFields(
    value,
    ["id", "name", "kind", "source", "allow", "maxPublisherToSubscriberBps"],
    field,
  );
  const id = parseServiceIdentifier(value.id, `${field}.id`);
  const name = parseNonEmptyString(value.name, `${field}.name`);
  const kind = value.kind === undefined ? "tcp" : value.kind;
  if (kind !== "tcp" && kind !== "http" && kind !== "udp") {
    throw new Error(`${field}.kind must be tcp, http, or udp`);
  }
  const source = parsePeerServiceSource(value.source, `${field}.source`);
  if (kind === "udp" && "unixSocket" in source) {
    throw new Error(`${field}.source Unix sockets cannot provide UDP services`);
  }
  const maxPublisherToSubscriberBps = value.maxPublisherToSubscriberBps as
    | number
    | undefined;
  if (
    maxPublisherToSubscriberBps !== undefined &&
    (!Number.isSafeInteger(maxPublisherToSubscriberBps) ||
      (maxPublisherToSubscriberBps as number) <= 0)
  ) {
    throw new Error(`${field}.maxPublisherToSubscriberBps must be a positive safe integer`);
  }
  return {
    id,
    name,
    kind,
    source,
    allow: parsePeerAllow(value.allow, `${field}.allow`),
    ...(maxPublisherToSubscriberBps === undefined
      ? {}
      : { maxPublisherToSubscriberBps }),
  };
}

function parsePeerBinding(value: unknown, field: string): PeerBinding {
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  rejectUnknownFields(value, ["peer", "service", "listen"], field);
  return {
    peer: parsePeerReference(value.peer, `${field}.peer`),
    service: parseServiceIdentifier(value.service, `${field}.service`),
    listen: parsePeerEndpoint(value.listen, `${field}.listen`, true),
  };
}

function resolvePeerReference(
  reference: string,
  peers: readonly PeerDefinition[],
  field: string,
): void {
  if (keyHexPattern.test(reference)) {
    if (!peers.some(({ publicKey }) => publicKey === reference)) {
      throw new Error(`${field} references an unknown peer public key`);
    }
    return;
  }
  if (!peers.some(({ label }) => label === reference)) {
    throw new Error(`${field} references an unknown peer label`);
  }
}

/** Parse the strict peer-oriented in-memory configuration shape. */
export function parsePeerConfig(value: unknown): PeerConfig {
  if (!isRecord(value)) throw new Error("peer config must be an object");
  rejectUnknownFields(value, ["network", "gateway", "peers", "services", "bindings"], "peer config");
  if (!Array.isArray(value.peers)) throw new Error("peers must be an array");
  if (!Array.isArray(value.services)) throw new Error("services must be an array");
  if (!Array.isArray(value.bindings)) throw new Error("bindings must be an array");
  const peers = value.peers.map((entry, index) => parsePeerDefinition(entry, `peers[${index}]`));
  const labels = new Set<string>();
  const publicKeys = new Set<string>();
  for (const peer of peers) {
    if (labels.has(peer.label)) throw new Error(`duplicate peer label: ${peer.label}`);
    if (publicKeys.has(peer.publicKey)) throw new Error(`duplicate peer public key: ${peer.publicKey}`);
    labels.add(peer.label);
    publicKeys.add(peer.publicKey);
  }
  const services = value.services.map((entry, index) => parsePeerService(entry, `services[${index}]`));
  const serviceIds = new Set<string>();
  for (const service of services) {
    if (serviceIds.has(service.id)) throw new Error(`duplicate service id: ${service.id}`);
    serviceIds.add(service.id);
    if ("peer" in service.source) {
      resolvePeerReference(service.source.peer, peers, "service source peer");
    }
    for (const publicKey of service.allow) {
      if (!publicKeys.has(publicKey)) {
        throw new Error(`service ${service.id} allow references an unknown peer public key`);
      }
    }
  }
  const bindings = value.bindings.map((entry, index) => parsePeerBinding(entry, `bindings[${index}]`));
  const bindingKeys = new Set<string>();
  for (const [index, binding] of bindings.entries()) {
    resolvePeerReference(binding.peer, peers, `bindings[${index}].peer`);
    if (!serviceIds.has(binding.service)) {
      // A binding intentionally names a remote service, so only the local
      // identifier syntax is known at this layer. Availability is resolved at
      // runtime from the authenticated remote catalog.
    }
    const peerKey = keyHexPattern.test(binding.peer)
      ? binding.peer
      : peers.find(({ label }) => label === binding.peer)!.publicKey;
    const key = `${peerKey}\u0000${binding.service}`;
    if (bindingKeys.has(key)) throw new Error(`duplicate service binding: ${binding.peer}/${binding.service}`);
    bindingKeys.add(key);
  }
  return {
    ...(value.network === undefined ? {} : { network: parsePeerNetwork(value.network) }),
    ...(value.gateway === undefined ? {} : { gateway: parsePeerGateway(value.gateway) }),
    peers,
    services,
    bindings,
  };
}

function parsePeerNetwork(value: unknown): PeerNetworkConfig {
  if (!isRecord(value)) throw new Error("network must be an object");
  rejectUnknownFields(value, ["bootstrap", "route"], "network");
  let bootstrap: import("./mux/hyperdht.js").DhtAddress[] | undefined;
  if (value.bootstrap !== undefined) {
    if (!Array.isArray(value.bootstrap)) throw new Error("network.bootstrap must be an array");
    bootstrap = value.bootstrap.map((entry, index) => {
      if (!isRecord(entry)) throw new Error(`network.bootstrap[${index}] must be an object`);
      rejectUnknownFields(entry, ["host", "port"], `network.bootstrap[${index}]`);
      if (typeof entry.host !== "string" || entry.host.length === 0) throw new Error(`network.bootstrap[${index}].host must be non-empty`);
      return { host: entry.host, port: parsePeerPort(entry.port, `network.bootstrap[${index}].port`, false) };
    });
    if (bootstrap.length === 0) bootstrap = undefined;
  }
  return {
    ...(bootstrap ? { bootstrap } : {}),
    ...(value.route === undefined ? {} : { route: parsePeerRoute(value.route) }),
  };
}

function parsePeerRoute(value: unknown): import("./mux/route.js").Route {
  if (value !== "auto" && value !== "public") throw new Error("network.route must be auto or public");
  return value;
}

function parsePeerGateway(value: unknown): PeerGatewayConfig {
  if (!isRecord(value)) throw new Error("gateway must be an object");
  rejectUnknownFields(value, ["port", "host", "domain"], "gateway");
  return {
    ...(value.port === undefined ? {} : { port: parsePeerPort(value.port, "gateway.port", true) }),
    ...(value.host === undefined ? {} : { host: parseNonEmptyString(value.host, "gateway.host") }),
    ...(value.domain === undefined ? {} : { domain: parseNonEmptyString(value.domain, "gateway.domain") }),
  };
}
