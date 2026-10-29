import type { Duplex, Readable, Writable } from "node:stream";
import { VPN_MTU } from "./packet-policy.js";

/** One packet at a time; callers must await delivery before reading the next packet. */
export class PacketFraming {
  private writing = false;
  constructor(private readonly readable: Readable, private readonly writable: Writable = readable as Duplex) {}

  async send(packet: Uint8Array): Promise<void> {
    if (packet.length < 20 || packet.length > VPN_MTU) throw new Error("invalid VPN packet length");
    if (this.writing) throw new Error("concurrent VPN packet writes are not supported");
    if (this.writable.destroyed) throw new Error("VPN stream is closed");
    this.writing = true;
    try {
      const frame = Buffer.allocUnsafe(packet.length + 2);
      frame.writeUInt16BE(packet.length);
      frame.set(packet, 2);
      if (!this.writable.write(frame)) await new Promise<void>((resolve, reject) => {
        const cleanup = (): void => {
          this.writable.off("drain", onDrain);
          this.writable.off("close", onClose);
          this.writable.off("error", onError);
        };
        const onDrain = (): void => { cleanup(); resolve(); };
        const onClose = (): void => { cleanup(); reject(new Error("VPN stream closed during write")); };
        const onError = (error: Error): void => { cleanup(); reject(error); };
        this.writable.once("drain", onDrain);
        this.writable.once("close", onClose);
        this.writable.once("error", onError);
        if (this.writable.destroyed) onClose();
      });
    } finally {
      this.writing = false;
    }
  }

  async receive(deliver: (packet: Buffer) => Promise<void>): Promise<void> {
    const header = Buffer.alloc(2);
    let headerBytes = 0;
    let packet: Buffer | undefined;
    let packetBytes = 0;
    try {
      for await (const data of this.readable) {
        const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
        let offset = 0;
        while (offset < chunk.length) {
          if (!packet) {
            const size = Math.min(2 - headerBytes, chunk.length - offset);
            chunk.copy(header, headerBytes, offset, offset + size);
            offset += size;
            headerBytes += size;
            if (headerBytes < 2) continue;
            const length = header.readUInt16BE();
            if (length < 20 || length > VPN_MTU) throw new Error("invalid VPN frame length");
            packet = Buffer.allocUnsafe(length);
            packetBytes = 0;
            headerBytes = 0;
          }
          const size = Math.min(packet.length - packetBytes, chunk.length - offset);
          chunk.copy(packet, packetBytes, offset, offset + size);
          packetBytes += size;
          offset += size;
          if (packetBytes === packet.length) {
            const complete = packet;
            packet = undefined;
            await deliver(complete);
          }
        }
      }
      if (headerBytes || packet) throw new Error("truncated VPN frame");
    } catch (error) {
      this.readable.destroy();
      this.writable.destroy();
      throw error;
    }
  }
}
