import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { formatInvitation } from "./invitation.js";
import { EnrollmentRejected } from "./enrollment-errors.js";

const KEY = /^[0-9a-f]{64}$/;
const TTL = 10 * 60_000;
const MAX_DEVICES = 16;
const MAX_INVITATIONS = 16;
const MAX_PORTS = 256;

export type ReceiverDevice = { publicKey: string; address: string; allowTcp: "all" | number[] };
type Pending = { digest: string; issuedAt: number; expiresAt: number; excludeAddress?: string };
type State = { version: 1; receiverKey: string; receiverAddress: string; pool: string; devices: ReceiverDevice[]; invitations: Pending[] };
export class ReceiverStorageError extends Error {
  constructor() { super("receiver storage failure"); }
}
export class InvitationExclusionError extends Error {
  constructor(readonly reason: "invalid" | "allocated") { super("invalid invitation exclusion"); }
}

function ipv4(value: string): number {
  const parts = value.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^(0|[1-9][0-9]{0,2})$/.test(part) || Number(part) > 255)) throw new Error("invalid IPv4 address");
  const bytes = parts.map(Number);
  if (bytes[0] === 0 || bytes[0] === 127 || bytes[0]! >= 224 || (bytes[0] === 169 && bytes[1] === 254)) throw new Error("invalid IPv4 address");
  return (((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0);
}

function address(value: number): string {
  return [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join(".");
}

function poolRange(pool: string): { first: number; last: number } {
  const match = /^([^/]+)\/(\d+)$/.exec(pool);
  if (!match) throw new Error("pool must be an IPv4 CIDR");
  const bits = Number(match[2]);
  if (bits < 16 || bits > 30 || String(bits) !== match[2]) throw new Error("pool prefix must be from 16 through 30");
  const base = ipv4(match[1]!);
  const size = 2 ** (32 - bits);
  if (base % size !== 0) throw new Error("pool must be a network address");
  // The entire pool must stay within one unicast range.
  ipv4(address(base + size - 1));
  return { first: base + 1, last: base + size - 2 };
}

function digest(secret: string): string {
  return createHash("sha256").update(Buffer.from(secret, "hex")).digest("hex");
}

function checkedPorts(value: unknown): "all" | number[] {
  if (value === "all") return value;
  if (!Array.isArray(value) || value.length > MAX_PORTS || value.some((n) => !Number.isInteger(n) || n < 1 || n > 65535) || new Set(value).size !== value.length) throw new Error("invalid TCP grant");
  return [...value] as number[];
}

function keys(value: unknown, names: string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join(",") === [...names].sort().join(",");
}

function validate(value: unknown, identity: { receiverKey: string; receiverAddress: string; pool: string }): State {
  if (!keys(value, ["version", "receiverKey", "receiverAddress", "pool", "devices", "invitations"]) || value.version !== 1 ||
      value.receiverKey !== identity.receiverKey || value.receiverAddress !== identity.receiverAddress || value.pool !== identity.pool ||
      !Array.isArray(value.devices) || value.devices.length > MAX_DEVICES || !Array.isArray(value.invitations) || value.invitations.length > MAX_INVITATIONS) throw new Error("invalid receiver state or configuration conflict");
  const range = poolRange(identity.pool);
  const addresses = new Set([identity.receiverAddress]);
  const deviceKeys = new Set<string>([identity.receiverKey]);
  const devices = value.devices.map((entry): ReceiverDevice => {
    if (!keys(entry, ["publicKey", "address", "allowTcp"]) || typeof entry.publicKey !== "string" || !KEY.test(entry.publicKey) ||
        typeof entry.address !== "string" || deviceKeys.has(entry.publicKey) || addresses.has(entry.address)) throw new Error("invalid receiver device");
    const number = ipv4(entry.address);
    if (number < range.first || number > range.last) throw new Error("receiver device address outside pool");
    deviceKeys.add(entry.publicKey); addresses.add(entry.address);
    return { publicKey: entry.publicKey, address: entry.address, allowTcp: checkedPorts(entry.allowTcp) };
  });
  const hashes = new Set<string>();
  const invitations = value.invitations.map((entry): Pending => {
    const hasExclusion = !!entry && typeof entry === "object" && "excludeAddress" in entry;
    if (!keys(entry, hasExclusion ? ["digest", "issuedAt", "expiresAt", "excludeAddress"] : ["digest", "issuedAt", "expiresAt"]) || typeof entry.digest !== "string" || !KEY.test(entry.digest) || hashes.has(entry.digest) ||
        typeof entry.issuedAt !== "number" || !Number.isSafeInteger(entry.issuedAt) || typeof entry.expiresAt !== "number" || entry.expiresAt !== entry.issuedAt + TTL) throw new Error("invalid receiver invitation state");
    if (hasExclusion && (typeof entry.excludeAddress !== "string" || !validExclusion(entry.excludeAddress, identity.receiverAddress, range))) throw new Error("invalid receiver invitation state");
    hashes.add(entry.digest);
    return { digest: entry.digest, issuedAt: entry.issuedAt, expiresAt: entry.expiresAt, ...(hasExclusion ? { excludeAddress: entry.excludeAddress as string } : {}) };
  });
  return { version: 1, ...identity, devices, invitations };
}

function validExclusion(value: string, receiverAddress: string, range: { first: number; last: number }): boolean {
  try { const n = ipv4(value); return value !== receiverAddress && n >= range.first && n <= range.last; }
  catch { return false; }
}

async function requirePrivateDirectory(directory: string): Promise<void> {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700 || (typeof process.getuid === "function" && info.uid !== process.getuid())) throw new Error("receiver state directory must be private and owned by this user");
}

/** Sole writer: the running receiver owns this store and serializes every mutation. */
export class ReceiverState {
  private tail: Promise<unknown> = Promise.resolve();
  private failed = false;
  private constructor(private readonly directory: string, private state: State, private readonly now: () => number) {}

  static async open(options: { directory: string; receiverKey: string; receiverAddress: string; pool: string; now?: () => number }): Promise<ReceiverState> {
    if (!KEY.test(options.receiverKey)) throw new Error("invalid receiver key");
    ipv4(options.receiverAddress); poolRange(options.pool);
    let created = false;
    try { await mkdir(options.directory, { mode: 0o700 }); created = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    await requirePrivateDirectory(options.directory);
    const identity = { receiverKey: options.receiverKey, receiverAddress: options.receiverAddress, pool: options.pool };
    const filename = path.join(options.directory, "receiver.json");
    let state: State;
    if (created) {
      state = { version: 1, ...identity, devices: [], invitations: [] };
      const store = new ReceiverState(options.directory, state, options.now ?? Date.now);
      await store.save(state);
      return store;
    }
    try {
      const info = await lstat(filename);
      if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600 || (typeof process.getuid === "function" && info.uid !== process.getuid()) || info.size > 256_000) throw new Error("receiver state file must be private");
      state = validate(JSON.parse(await readFile(filename, "utf8")) as unknown, identity);
    } catch (error) {
      throw new Error("cannot read or validate receiver state", { cause: error });
    }
    return new ReceiverState(options.directory, state, options.now ?? Date.now);
  }

  private async save(next: State): Promise<void> {
    const temp = path.join(this.directory, `.receiver-${randomBytes(16).toString("hex")}`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temp, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(next)}\n`);
      await handle.sync();
      await handle.close(); handle = undefined;
      await rename(temp, path.join(this.directory, "receiver.json"));
      const dir = await open(this.directory, "r");
      try { await dir.sync(); } finally { await dir.close(); }
      this.state = next;
    } catch {
      // A failed durable write can have committed a rename. Refuse all further
      // operations until the owner stops and reopens the authoritative file.
      this.failed = true;
      throw new ReceiverStorageError();
    } finally {
      await handle?.close();
      await unlink(temp).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    }
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.tail.then(() => {
      if (this.failed) throw new ReceiverStorageError();
      return operation();
    });
    this.tail = task.catch(() => undefined);
    return task;
  }

  list(): Promise<ReceiverDevice[]> {
    return this.serial(async () => this.state.devices.map((device) => ({ ...device, allowTcp: device.allowTcp === "all" ? "all" : [...device.allowTcp] })));
  }

  createInvitation(excludeAddress?: string): Promise<string> {
    return this.serial(async () => {
      if (excludeAddress !== undefined) {
        if (!validExclusion(excludeAddress, this.state.receiverAddress, poolRange(this.state.pool))) throw new InvitationExclusionError("invalid");
        if (this.state.devices.some((device) => device.address === excludeAddress)) throw new InvitationExclusionError("allocated");
      }
      const now = this.now();
      const invitations = this.state.invitations.filter((entry) => entry.issuedAt <= now && now < entry.expiresAt);
      if (invitations.length >= MAX_INVITATIONS) throw new Error("too many outstanding invitations");
      const secret = randomBytes(32).toString("hex");
      invitations.push({ digest: digest(secret), issuedAt: now, expiresAt: now + TTL, ...(excludeAddress === undefined ? {} : { excludeAddress }) });
      await this.save({ ...this.state, invitations });
      return formatInvitation({ receiverKey: this.state.receiverKey, secret });
    });
  }

  enroll(publicKey: string, secret: string): Promise<ReceiverDevice> {
    return this.serial(async () => {
      if (!KEY.test(publicKey) || publicKey === this.state.receiverKey || !KEY.test(secret)) throw new Error("unusable invitation");
      const hash = digest(secret), now = this.now();
      const pending = this.state.invitations.find((entry) => entry.digest === hash && entry.issuedAt <= now && now < entry.expiresAt);
      if (!pending) throw new Error("unusable invitation");
      let device = this.state.devices.find((entry) => entry.publicKey === publicKey);
      if (device && device.address === pending.excludeAddress) throw new EnrollmentRejected("excluded");
      if (!device) {
        if (this.state.devices.length >= MAX_DEVICES) throw new EnrollmentRejected("capacity");
        const range = poolRange(this.state.pool);
        const taken = new Set([this.state.receiverAddress, ...this.state.devices.map((entry) => entry.address)]);
        if (pending.excludeAddress) taken.add(pending.excludeAddress);
        let available: string | undefined;
        for (let n = range.first; n <= range.last; n++) {
          const candidate = address(n);
          if (!taken.has(candidate)) { available = candidate; break; }
        }
        if (!available) throw new EnrollmentRejected("pool");
        device = { publicKey, address: available, allowTcp: "all" };
      }
      const devices = this.state.devices.some((entry) => entry.publicKey === publicKey) ? this.state.devices : [...this.state.devices, device];
      await this.save({ ...this.state, devices, invitations: this.state.invitations.filter((entry) => entry !== pending && entry.issuedAt <= now && now < entry.expiresAt) });
      return { ...device, allowTcp: device.allowTcp === "all" ? "all" : [...device.allowTcp] };
    });
  }

  grant(publicKey: string, ports: "all" | number[]): Promise<void> {
    return this.serial(async () => {
      const grant = checkedPorts(ports);
      if (!this.state.devices.some((entry) => entry.publicKey === publicKey)) throw new Error("unknown receiver device");
      await this.save({ ...this.state, devices: this.state.devices.map((entry) => entry.publicKey === publicKey ? { ...entry, allowTcp: grant } : entry) });
    });
  }

  revoke(publicKey: string): Promise<void> {
    return this.serial(async () => {
      if (!this.state.devices.some((entry) => entry.publicKey === publicKey)) throw new Error("unknown receiver device");
      await this.save({ ...this.state, devices: this.state.devices.filter((entry) => entry.publicKey !== publicKey) });
    });
  }
}
