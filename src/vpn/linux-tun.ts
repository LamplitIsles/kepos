import { spawn, execFile } from "node:child_process";
import type { Readable } from "node:stream";
import { promisify } from "node:util";
import { PacketFraming } from "./framing.js";

const exec = promisify(execFile);

/** Node/Linux adapter. Closing its non-persistent TUN removes its routes. */
export async function openLinuxTun(options: {
  helper: string;
  address: string;
  peerAddresses: readonly string[];
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
    await ip("address", "add", `${options.address}/32`, "dev", name);
    await ip("link", "set", "dev", name, "mtu", "1400", "up");
    for (const address of options.peerAddresses) await ip("route", "add", `${address}/32`, "dev", name);
    return { name, packets: new PacketFraming(child.stdout, child.stdin), closed, close };
  } catch (error) {
    await close();
    throw error;
  }
}
