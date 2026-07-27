export type ObservationRole = "publisher" | "subscriber";
export type ObservationDirection =
  | "subscriber-to-publisher"
  | "publisher-to-subscriber";
export type ObservationName =
  | "outer.attempt"
  | "outer.handshake"
  | "outer.holepunch"
  | "outer.connected"
  | "outer.control-ready"
  | "outer.unhealthy"
  | "outer.retry"
  | "outer.restored"
  | "outer.closed"
  | "outer.accepted"
  | "outer.rejected"
  | "outer.replaced"
  | "pairing.invitation-created"
  | "pairing.invitation-expired"
  | "pairing.requested"
  | "pairing.rejected"
  | "pairing.approved"
  | "pairing.denied"
  | "pairing.cancelled"
  | "pairing.approval-error"
  | "channel.open"
  | "channel.open-ok"
  | "channel.open-error"
  | "channel.first-byte"
  | "channel.fin"
  | "channel.reset"
  | "channel.pause"
  | "channel.resume"
  | "channel.close";

export interface Observation {
  component: "kepos";
  timestamp: string;
  elapsedMs: number;
  event: ObservationName;
  role: ObservationRole;
  route?: string;
  outerId?: string;
  channelId?: string;
  serviceId?: string;
  direction?: ObservationDirection;
  bytes?: number;
  error?: string;
  trigger?: string;
  [field: string]: unknown;
}

export type Observe = (observation: Observation) => void;
export type ObservationFields = Record<string, unknown>;
export type EmitObservation = (
  event: ObservationName,
  fields?: ObservationFields,
) => void;

export interface ObserverOptions {
  enabled: boolean;
  role: ObservationRole;
  route?: string;
  outerId?: string;
  now?: () => number;
  write?: (line: string) => void;
}

export interface ObservationEmitterOptions {
  observe?: Observe;
  role: ObservationRole;
  route?: string;
  outerId?: string;
  channelId?: string;
  serviceId?: string;
  now?: () => number;
  startedAt?: number;
}

export function createObserver(options: ObserverOptions): EmitObservation {
  if (!options.enabled) return () => undefined;

  const write = options.write ?? console.log;
  return createObservationEmitter({
    ...options,
    observe: (observation) => write(JSON.stringify(observation)),
  });
}

export function createObservationEmitter(
  options: ObservationEmitterOptions,
): EmitObservation {
  if (!options.observe) return () => undefined;

  const now = options.now ?? Date.now;
  const startedAt = options.startedAt ?? now();

  return (event, fields = {}) => {
    const sanitized = sanitizeObservation(fields);
    const safeFields =
      sanitized !== null &&
      typeof sanitized === "object" &&
      !Array.isArray(sanitized)
        ? sanitized
        : {};
    const observedAt = now();
    options.observe?.({
      ...safeFields,
      component: "kepos",
      timestamp: new Date(observedAt).toISOString(),
      elapsedMs: observedAt - startedAt,
      role: options.role,
      ...(options.route ? { route: options.route } : {}),
      ...(options.outerId ? { outerId: options.outerId } : {}),
      ...(options.channelId ? { channelId: options.channelId } : {}),
      ...(options.serviceId ? { serviceId: options.serviceId } : {}),
      event,
    });
  };
}

export function sanitizeObservation(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeObservation);
  if (b4a.isBuffer(value)) return b4a.toString(value, "hex");
  if (value === null || typeof value !== "object") return value;

  const sanitized: ObservationFields = {};
  for (const [key, field] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase();
    if (
      normalizedKey.includes("secret") ||
      normalizedKey.includes("seed") ||
      normalizedKey.includes("token")
    ) {
      continue;
    }
    if (
      (normalizedKey === "publickey" ||
        normalizedKey === "remotepublickey") &&
      (typeof field === "string" || b4a.isBuffer(field))
    ) {
      const keyHex = b4a.isBuffer(field) ? b4a.toString(field, "hex") : field;
      sanitized[key] = keyHex.slice(0, 16);
      continue;
    }
    sanitized[key] = sanitizeObservation(field);
  }
  return sanitized;
}

export function createObservationId(prefix: string): string {
  return `${prefix}-${b4a.toString(crypto.randomBytes(8), "hex")}`;
}
import b4a from "b4a";
import crypto from "hypercore-crypto";
