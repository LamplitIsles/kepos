import {
  encodeFrame,
  FrameDecoder,
} from "@lamplitisles/bare-host-protocol/framing";
import type {
  HostEnvelope,
  RequestEnvelope,
} from "@lamplitisles/bare-host-protocol/messages";
import b4a from "b4a";

export type WorkletState =
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "failed";

export interface WorkletControllerOptions {
  runtimeId: string;
  echoUrl: string;
  write(frame: Uint8Array): void;
  stopEcho(): Promise<void>;
  configurePeer?(
    publicKey: string,
    label: string,
    connection: "dial" | "accept",
  ): Promise<unknown>;
  pairPeer?(
    invitation: string,
    deviceLabel: string,
    platform: string,
  ): Promise<unknown>;
  status?(): Record<string, unknown>;
}

/** Small, canonical host boundary: configuration belongs to the peer config file. */
export class WorkletController {
  private readonly decoder = new FrameDecoder();
  private state: WorkletState = "starting";
  private receiveTask: Promise<void> = Promise.resolve();

  constructor(private readonly options: WorkletControllerOptions) {}

  start(): void {
    if (this.state !== "starting") return;
    this.state = "running";
    this.emitState();
  }

  publishStatus(): void {
    if (this.state !== "running") return;
    this.emitState();
  }

  receive(chunk: Uint8Array): Promise<void> {
    const task = this.receiveTask.then(() => this.receiveChunk(chunk));
    this.receiveTask = task.catch(() => undefined);
    return task;
  }

  private async receiveChunk(chunk: Uint8Array): Promise<void> {
    for (const envelope of this.decoder.push(chunk)) {
      if (envelope.kind !== "request") {
        throw new Error("Worklet accepts only control requests");
      }
      await this.handleRequest(envelope);
    }
  }

  private async handleRequest(request: RequestEnvelope): Promise<void> {
    if (request.method === "ping") {
      this.respond(request, { pong: true, runtimeId: this.options.runtimeId });
      return;
    }
    if (request.method === "status") {
      this.respond(request, this.snapshot());
      return;
    }
    if (request.method === "configure") {
      await this.configure(request);
      return;
    }
    if (request.method === "pair") {
      await this.pair(request);
      return;
    }
    this.state = "stopping";
    this.emitState();
    await this.options.stopEcho();
    this.state = "stopped";
    this.emitState();
    this.respond(request, { stopped: true, runtimeId: this.options.runtimeId });
  }

  private async configure(request: RequestEnvelope): Promise<void> {
    try {
      const fields = objectParams(request.params, "configuration");
      const publicKey = fields.publicKey;
      if (
        typeof publicKey !== "string" ||
        !/^[0-9a-f]{64}$/u.test(publicKey)
      ) {
        throw new Error("publicKey must be 32 bytes of lowercase hex");
      }
      const label = fields.label === undefined ? "peer" : fields.label;
      if (
        typeof label !== "string" ||
        label.length === 0 ||
        label.trim() !== label ||
        b4a.byteLength(label, "utf8") > 128
      ) {
        throw new Error("label must be a non-empty bounded label");
      }
      const connection = fields.connection === undefined ? "dial" : fields.connection;
      if (connection !== "dial" && connection !== "accept") {
        throw new Error("connection must be dial or accept");
      }
      const callback = this.options.configurePeer;
      if (!callback) throw new Error("peer configuration is unavailable");
      const result = await callback(publicKey, label, connection);
      this.emitState();
      this.respond(request, result);
    } catch (error) {
      this.write({
        version: 1,
        kind: "error",
        id: request.id,
        error: {
          code: "invalid_configuration",
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private async pair(request: RequestEnvelope): Promise<void> {
    try {
      const fields = objectParams(request.params, "pairing");
      if (
        typeof fields.invitation !== "string" ||
        fields.invitation.length > 2_048 ||
        !fields.invitation.startsWith("kepos://pair?") ||
        typeof fields.deviceLabel !== "string" ||
        fields.deviceLabel.length === 0 ||
        b4a.byteLength(fields.deviceLabel, "utf8") > 128 ||
        typeof fields.platform !== "string" ||
        !/^[a-z0-9][a-z0-9_-]{0,31}$/u.test(fields.platform)
      ) {
        throw new Error("pairing parameters are invalid");
      }
      const callback = this.options.pairPeer;
      if (!callback) throw new Error("peer pairing is unavailable");
      const result = await callback(
        fields.invitation,
        fields.deviceLabel,
        fields.platform,
      );
      this.emitState();
      this.respond(request, result);
    } catch (error) {
      this.write({
        version: 1,
        kind: "error",
        id: request.id,
        error: {
          code: "invalid_pairing",
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private snapshot(): Record<string, unknown> {
    return {
      state: this.state,
      runtimeId: this.options.runtimeId,
      echoUrl: this.options.echoUrl,
      ...this.options.status?.(),
    };
  }

  private emitState(): void {
    this.write({
      version: 1,
      kind: "event",
      event: "runtime.stateChanged",
      data: this.snapshot(),
    });
  }

  private respond(request: RequestEnvelope, result: unknown): void {
    this.write({
      version: 1,
      kind: "response",
      id: request.id,
      result,
    });
  }

  private write(envelope: HostEnvelope): void {
    this.options.write(encodeFrame(envelope));
  }
}

function objectParams(value: unknown, subject: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${subject} parameters are required`);
  }
  return value as Record<string, unknown>;
}
