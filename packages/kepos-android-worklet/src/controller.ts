import {
  encodeFrame,
  FrameDecoder,
} from "@lamplitisles/bare-host-protocol/framing";
import type {
  HostEnvelope,
  RequestEnvelope,
} from "@lamplitisles/bare-host-protocol/messages";

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
    this.state = "stopping";
    this.emitState();
    await this.options.stopEcho();
    this.state = "stopped";
    this.emitState();
    this.respond(request, { stopped: true, runtimeId: this.options.runtimeId });
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
