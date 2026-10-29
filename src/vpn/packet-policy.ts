/** IPv4 packet admission, independent of any operating-system packet interface. */
export const VPN_MTU = 1400;
const MAX_FLOWS = 4096;
const HANDSHAKE_IDLE_MS = 5 * 60_000;
const CLOSED_GRACE_MS = 60_000;

type Direction = "in" | "out";
interface Packet {
  source: string;
  destination: string;
  protocol: number;
  header: number;
  bytes: Buffer;
}
interface Flow {
  initiator: Direction;
  sequence: number;
  replied: boolean;
  established: boolean;
  responseSequence?: number;
  finIn?: number;
  finOut?: number;
  ackIn?: number;
  ackOut?: number;
  closedAt?: number;
  lastSeen: number;
}

// TCP serial arithmetic is defined within a half sequence space.
function reaches(value: number, target: number): boolean {
  return ((value - target) | 0) >= 0;
}

function checksum(bytes: Uint8Array, initial = 0): number {
  let sum = initial;
  for (let i = 0; i < bytes.length; i += 2) {
    sum += (bytes[i]! << 8) | (bytes[i + 1] ?? 0);
  }
  while (sum >>> 16) sum = (sum & 0xffff) + (sum >>> 16);
  return sum & 0xffff;
}

function address(bytes: Uint8Array, offset: number): string {
  return Array.from(bytes.subarray(offset, offset + 4)).join(".");
}

function ipv4(bytes: Buffer): Packet | undefined {
  if (bytes.length < 20 || bytes.length > VPN_MTU || bytes[0]! >>> 4 !== 4) return;
  const header = (bytes[0]! & 15) * 4;
  if (header !== 20 || bytes.readUInt16BE(2) !== bytes.length || bytes[8] === 0) return;
  // Reserved flag, more fragments and fragment offset are all forbidden.
  if ((bytes.readUInt16BE(6) & 0xbfff) !== 0 || checksum(bytes.subarray(0, header)) !== 0xffff) return;
  return { source: address(bytes, 12), destination: address(bytes, 16), protocol: bytes[9]!, header, bytes };
}

function tuple(localPort: number, remotePort: number): string {
  return `${localPort}:${remotePort}`;
}

/** A policy instance belongs to one authenticated peer and one connection generation. */
export class PacketPolicy {
  private readonly flows = new Map<string, Flow>();
  private readonly closed = new Set<string>();
  private ports: Set<number> | "all";
  private nextSweep = 0;

  constructor(
    readonly localAddress: string,
    readonly peerAddress: string,
    ports: readonly number[] | "all",
    private readonly now: () => number = Date.now,
  ) {
    this.ports = ports === "all" ? "all" : new Set(ports);
  }

  /** Revocation destroys all tracked flows, including established ones. */
  setPorts(ports: readonly number[] | "all"): void {
    this.ports = ports === "all" ? "all" : new Set(ports);
    this.flows.clear();
    this.closed.clear();
  }

  clear(): void { this.flows.clear(); this.closed.clear(); }

  private remove(key: string): void { this.flows.delete(key); this.closed.delete(key); }

  admit(bytes: Buffer, direction: Direction): boolean {
    const packet = ipv4(bytes);
    if (!packet) return false;
    const expectedSource = direction === "in" ? this.peerAddress : this.localAddress;
    const expectedDestination = direction === "in" ? this.localAddress : this.peerAddress;
    if (packet.source !== expectedSource || packet.destination !== expectedDestination) return false;
    const now = this.now();
    if (now >= this.nextSweep) {
      for (const [key, flow] of this.flows) {
        if ((flow.closedAt !== undefined && now - flow.closedAt >= CLOSED_GRACE_MS) ||
            (!flow.established && now - flow.lastSeen >= HANDSHAKE_IDLE_MS)) this.remove(key);
      }
      this.nextSweep = now + 1_000;
    }
    if (packet.protocol === 1) return this.admitIcmp(packet, direction, now);
    if (packet.protocol !== 6) return false;
    const tcp = bytes.subarray(packet.header);
    if (tcp.length < 20 || (tcp[12]! >>> 4) * 4 < 20 || (tcp[12]! >>> 4) * 4 > tcp.length) return false;
    const pseudo = Buffer.alloc(12);
    bytes.copy(pseudo, 0, 12, 20);
    pseudo[9] = 6;
    pseudo.writeUInt16BE(tcp.length, 10);
    if (checksum(tcp, checksum(pseudo)) !== 0xffff) return false;
    const sourcePort = tcp.readUInt16BE(0);
    const destinationPort = tcp.readUInt16BE(2);
    if (sourcePort === 0 || destinationPort === 0) return false;
    const key = direction === "out" ? tuple(sourcePort, destinationPort) : tuple(destinationPort, sourcePort);
    const flags = tcp[13]!;
    const syn = (flags & 2) !== 0;
    const ack = (flags & 16) !== 0;
    const rst = (flags & 4) !== 0;
    if (syn && ((flags & 5) !== 0 || tcp.length !== (tcp[12]! >>> 4) * 4)) return false;
    let flow = this.flows.get(key);
    // A fresh SYN on a closed tuple is a new connection and must pass the grant again.
    if (flow?.closedAt !== undefined && syn && !ack) {
      if (direction === "in" && this.ports !== "all" && !this.ports.has(destinationPort)) return false;
      this.remove(key);
      flow = undefined;
    }
    if (!flow) {
      if (!syn || ack || rst) return false;
      if (direction === "in" && this.ports !== "all" && !this.ports.has(destinationPort)) return false;
      if (this.flows.size >= MAX_FLOWS) {
        const oldestClosed = this.closed.values().next().value;
        if (oldestClosed === undefined) return false;
        this.remove(oldestClosed);
      }
      flow = { initiator: direction, sequence: tcp.readUInt32BE(4), replied: false, established: false, lastSeen: now };
      this.flows.set(key, flow);
      return true;
    }
    if (!flow.replied) {
      if (direction === flow.initiator) {
        if (!syn || ack || tcp.readUInt32BE(4) !== flow.sequence) return false;
      } else if (rst && ack && tcp.readUInt32BE(8) === ((flow.sequence + 1) >>> 0)) {
        this.remove(key);
        return true;
      } else {
        if (!syn || !ack || tcp.readUInt32BE(8) !== ((flow.sequence + 1) >>> 0)) return false;
        flow.replied = true;
        flow.responseSequence = tcp.readUInt32BE(4);
      }
    } else if (!flow.established) {
      if (direction === flow.initiator) {
        if (syn && !ack && tcp.readUInt32BE(4) === flow.sequence) {
          flow.lastSeen = now;
          return true;
        }
        if (rst && !syn && tcp.readUInt32BE(4) === ((flow.sequence + 1) >>> 0) &&
            (!ack || tcp.readUInt32BE(8) === ((flow.responseSequence! + 1) >>> 0))) {
          this.remove(key);
          return true;
        }
        if (!ack || syn || tcp.readUInt32BE(4) !== ((flow.sequence + 1) >>> 0) ||
            tcp.readUInt32BE(8) !== ((flow.responseSequence! + 1) >>> 0)) return false;
        flow.established = true;
      } else {
        if (!syn || !ack || tcp.readUInt32BE(4) !== flow.responseSequence ||
            tcp.readUInt32BE(8) !== ((flow.sequence + 1) >>> 0)) return false;
      }
    } else if (syn && !ack && direction !== flow.initiator) {
      return false;
    }
    flow.lastSeen = now;
    if (rst) { this.remove(key); return true; }
    if (flow.established) {
      if (ack) {
        const value = tcp.readUInt32BE(8);
        const previous = direction === "in" ? flow.ackIn : flow.ackOut;
        if (previous === undefined || reaches(value, previous)) {
          if (direction === "in") flow.ackIn = value; else flow.ackOut = value;
        }
      }
      if ((flags & 1) !== 0) {
        const end = (tcp.readUInt32BE(4) + tcp.length - (tcp[12]! >>> 4) * 4 + 1) >>> 0;
        if (direction === "in") flow.finIn ??= end; else flow.finOut ??= end;
      }
      if (flow.closedAt === undefined && flow.finIn !== undefined && flow.finOut !== undefined &&
          flow.ackOut !== undefined && reaches(flow.ackOut, flow.finIn) &&
          flow.ackIn !== undefined && reaches(flow.ackIn, flow.finOut)) {
        flow.closedAt = now;
        this.closed.add(key);
      }
    }
    return true;
  }

  private admitIcmp(packet: Packet, direction: Direction, now: number): boolean {
    const icmp = packet.bytes.subarray(packet.header);
    // Destination unreachable (including fragmentation needed), time exceeded, parameter problem.
    if (icmp.length < 8 + 20 + 8 || ![3, 11, 12].includes(icmp[0]!) || checksum(icmp) !== 0xffff) return false;
    const inner = icmp.subarray(8);
    const header = (inner[0]! & 15) * 4;
    if (inner[0]! >>> 4 !== 4 || header !== 20 || inner.length < header + 8 || inner.readUInt16BE(2) < header + 8 || inner[9] !== 6 ||
        (inner.readUInt16BE(6) & 0xbfff) !== 0 || checksum(inner.subarray(0, header)) !== 0xffff) return false;
    const expectedSource = direction === "in" ? this.localAddress : this.peerAddress;
    const expectedDestination = direction === "in" ? this.peerAddress : this.localAddress;
    if (address(inner, 12) !== expectedSource || address(inner, 16) !== expectedDestination) return false;
    const sourcePort = inner.readUInt16BE(header);
    const destinationPort = inner.readUInt16BE(header + 2);
    const key = direction === "in" ? tuple(sourcePort, destinationPort) : tuple(destinationPort, sourcePort);
    const flow = this.flows.get(key);
    if (!flow) return false;
    flow.lastSeen = now;
    return true;
  }
}
