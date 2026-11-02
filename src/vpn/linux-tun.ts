import { spawn, execFile } from "node:child_process";
import type { Readable } from "node:stream";
import { promisify } from "node:util";
import { PacketFraming } from "./framing.js";

const exec = promisify(execFile);

export class ReceiverRouteConflict extends Error {
  constructor() { super("Receiver pool conflicts with an existing IPv4 route"); }
}

async function readRoutes(): Promise<unknown[]> {
  let routes: unknown;
  try { routes = JSON.parse((await exec("ip", ["-j", "-4", "route", "show", "table", "all"])).stdout) as unknown; }
  catch { throw new Error("Cannot inspect existing IPv4 routes"); }
  if (!Array.isArray(routes)) throw new Error("Cannot inspect existing IPv4 routes");
  return routes;
}

/** Fail before allocating if the pool overlaps a configured non-default route. */
export async function checkPoolRoutes(pool: string, ignoreInterface?: string): Promise<void> {
  const routes = await readRoutes();
  const base = pool.split("/")[0]!;
  for (const item of routes) {
    if (!item || typeof item !== "object" || !("dst" in item) || typeof item.dst !== "string" || item.dst === "default" || item.dst === "0.0.0.0/0" || (ignoreInterface && "dev" in item && item.dev === ignoreInterface)) continue;
    if (routeContains(item.dst, base) || routeContains(pool, item.dst.split("/")[0]!)) throw new ReceiverRouteConflict();
  }
}

/** Node/Linux adapter. Closing its non-persistent TUN removes its routes. */
export async function openLinuxTun(options: {
  helper: string;
  address: string;
  peerAddresses: readonly string[];
  checkRouteConflicts?: boolean;
}): Promise<{ name: string; packets: PacketFraming; closed: Promise<Error>; close: () => Promise<void> }> {
  if (process.platform !== "linux") throw new Error("VPN TUN is supported only on Linux");
  const child = spawn(options.helper, [], { stdio: ["pipe", "pipe", "pipe", "pipe"] });
  child.stdin.on("error", () => undefined);
  child.stdout.on("error", () => undefined);
  let detail = "";
  child.stderr.on("data", (chunk: Buffer) => { detail = (detail + chunk.toString()).slice(-4096); });
  const closed = new Promise<Error>((resolve) => {
    child.once("error", (error) => resolve(new Error(`Cannot start TUN helper ${options.helper}: ${error.message}`)));
    child.once("exit", (code, signal) => resolve(new Error(`TUN helper exited (${signal ?? code}): ${detail.trim()}`)));
  });
  const ready = new Promise<string>((resolve, reject) => {
    let name = "";
    const pipe = child.stdio[3] as Readable;
    pipe.on("data", (chunk: Buffer) => {
      name += chunk.toString();
      if (name.length > 16) reject(new Error("TUN helper returned an invalid interface name"));
      if (name.includes("\n")) {
        const parsed = name.trim();
        if (!/^kep[0-9]+$/.test(parsed)) reject(new Error("TUN helper returned an invalid interface name"));
        else resolve(parsed);
      }
    });
    pipe.once("end", () => reject(new Error("TUN helper closed before interface was ready")));
    pipe.once("error", reject);
    void closed.then(reject);
  });
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      child.stdin.destroy();
      child.kill("SIGTERM");
      await closed;
    })();
    return closing;
  };
  try {
    const name = await ready;
    const ip = async (...args: string[]): Promise<void> => {
      try { await exec("ip", args); }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Cannot configure TUN (requires iproute2 and CAP_NET_ADMIN): ${message}`);
      }
    };
    if (options.checkRouteConflicts) {
      const routes = await readRoutes();
      for (const address of options.peerAddresses) {
        if (routes.some((route) => route && typeof route === "object" && "dst" in route && typeof route.dst === "string" && routeContains(route.dst, address))) {
          throw new Error("Allocated peer address conflicts with an existing IPv4 route");
        }
      }
    }
    await ip("address", "add", `${options.address}/32`, "dev", name);
    await ip("link", "set", "dev", name, "mtu", "1400", "up");
    for (const address of options.peerAddresses) await ip("route", "add", `${address}/32`, "dev", name);
    return { name, packets: new PacketFraming(child.stdout, child.stdin), closed, close };
  } catch (error) {
    await close();
    throw error;
  }
}

export function routeContains(route: string, address: string): boolean {
  if (route === "default" || route === "0.0.0.0/0") return false;
  const parts = route.split("/");
  const bits = parts.length === 1 ? 32 : Number(parts[1]);
  const toNumber = (input: string): number | undefined => {
    const fields = input.split(".");
    if (fields.length !== 4 || fields.some((value) => !/^\d{1,3}$/.test(value) || Number(value) > 255)) return;
    return fields.reduce((result, value) => ((result << 8) | Number(value)) >>> 0, 0);
  };
  const network = toNumber(parts[0]!), target = toNumber(address);
  if (parts.length > 2 || !Number.isInteger(bits) || bits < 1 || bits > 32 || network === undefined || target === undefined) return false;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (network & mask) === (target & mask);
}
