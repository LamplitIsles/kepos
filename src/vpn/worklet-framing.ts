import type { Duplex } from "node:stream";

// Provider/worklet IPC is a byte stream. These frames are local IPC, not the
// peer VPN protocol. A frame contains a one-byte kind and a bounded payload.
export const IPC_CONTROL = 1;
export const IPC_PACKET = 2;
export const IPC_MAX_FRAME = 32_768;

export class WorkletFraming {
  private writeTail: Promise<void> = Promise.resolve();
  private pending = 0;
  private diagnosticPending = false;
  constructor(private readonly stream: Duplex) {}

  send(kind: number, payload: Uint8Array): Promise<void> {
    if ((kind !== IPC_CONTROL && kind !== IPC_PACKET) || payload.length + 1 > IPC_MAX_FRAME) {
      return Promise.reject(new Error("invalid IPC frame"));
    }
    // Packet writes are already serialized by the engine. Bound asynchronous
    // status/control messages too, including while the receiver is stalled.
    if (this.pending >= 32) return Promise.reject(new Error("IPC output is congested"));
    this.pending++;
    const frame = Buffer.allocUnsafe(payload.length + 3);
    frame.writeUInt16BE(payload.length + 1, 0);
    frame[2] = kind;
    frame.set(payload, 3);
    const task = this.writeTail.then(() => this.write(frame));
    this.writeTail = task.catch(() => undefined);
    return task.finally(() => { this.pending--; });
  }

  // Diagnostics are best effort: never occupy a normal message queue slot or
  // cause the VPN to fail if the IPC stream is busy or closed.
  sendDiagnostic(payload: Uint8Array): void {
    if (this.pending || this.diagnosticPending || this.stream.destroyed || payload.length + 1 > IPC_MAX_FRAME) return;
    this.diagnosticPending = true;
    const frame = Buffer.allocUnsafe(payload.length + 3);
    frame.writeUInt16BE(payload.length + 1, 0);
    frame[2] = IPC_CONTROL;
    frame.set(payload, 3);
    const task = this.writeTail.then(() => this.write(frame));
    this.writeTail = task.catch(() => undefined);
    void task.catch(() => undefined).finally(() => { this.diagnosticPending = false; });
  }

  private async write(frame: Buffer): Promise<void> {
    if (this.stream.destroyed) throw new Error("IPC is closed");
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => {
        this.stream.off("close", onClose);
        this.stream.off("error", onError);
      };
      const finish = (error?: Error | null): void => {
        if (settled) return;
        settled = true;
        // A failed write can still emit an error before close; keep its
        // listeners until close so the stream failure remains handled.
        if (error) reject(error);
        else { cleanup(); resolve(); }
      };
      const onClose = (): void => { finish(new Error("IPC is closed")); cleanup(); };
      const onError = (error: Error): void => { finish(error); };
      this.stream.once("close", onClose);
      this.stream.once("error", onError);
      try { this.stream.write(frame, finish); }
      catch (error) { finish(error instanceof Error ? error : new Error("IPC write failed")); cleanup(); }
      if (this.stream.destroyed) onClose();
    });
  }

  async receive(deliver: (kind: number, payload: Buffer) => Promise<void>): Promise<void> {
    const header = Buffer.alloc(2);
    let headerBytes = 0;
    let frame: Buffer | undefined;
    let frameBytes = 0;
    for await (const data of this.stream) {
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
      let offset = 0;
      while (offset < chunk.length) {
        if (!frame) {
          const count = Math.min(2 - headerBytes, chunk.length - offset);
          chunk.copy(header, headerBytes, offset, offset + count);
          offset += count;
          headerBytes += count;
          if (headerBytes !== 2) continue;
          const length = header.readUInt16BE();
          if (length < 1 || length > IPC_MAX_FRAME) throw new Error("invalid IPC frame length");
          frame = Buffer.allocUnsafe(length);
          frameBytes = 0;
          headerBytes = 0;
        }
        const count = Math.min(frame.length - frameBytes, chunk.length - offset);
        chunk.copy(frame, frameBytes, offset, offset + count);
        frameBytes += count;
        offset += count;
        if (frameBytes === frame.length) {
          const complete = frame;
          frame = undefined;
          if (complete[0] !== IPC_CONTROL && complete[0] !== IPC_PACKET) throw new Error("unknown IPC frame kind");
          await deliver(complete[0]!, complete.subarray(1));
        }
      }
    }
    if (headerBytes || frame) throw new Error("truncated IPC frame");
  }
}
