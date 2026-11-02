import { lstat, unlink } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import type { PeerConfig } from "../config.js";
import { getPeerPublicKey } from "../state/peer.js";
import { InvitationExclusionError, ReceiverState, ReceiverStorageError } from "./receiver-state.js";
import { startVpn } from "./runtime.js";
import { checkPoolRoutes, ReceiverRouteConflict } from "./linux-tun.js";
import { EnrollmentRejected } from "./enrollment-errors.js";

export function receiverDirectory(stateDir: string): string {
  const resolved = path.resolve(stateDir);
  return path.join(path.dirname(resolved), `.${path.basename(resolved)}.receiver`);
}

function socketPath(stateDir: string): string { return path.join(receiverDirectory(stateDir), "control.sock"); }

type Request = { action: "invite" | "list" | "grant" | "revoke"; key?: string; ports?: "all" | number[]; excludeAddress?: string };

/** Private local IPC; the identity lock makes this process the sole receiver writer. */
export async function startReceiver(options: {
  stateDir: string; config: PeerConfig; pool: string; helper: string;
  start?: typeof startVpn; log?: (message: string) => void;
  checkPool?: typeof checkPoolRoutes;
}): Promise<{ failed: Promise<Error>; stop: () => Promise<void> }> {
  const { config } = options;
  if (!config.vpn || config.peers.length || config.vpn.peers.length) throw new Error("receiver config requires a VPN address and no static peers");
  const publicKey = await getPeerPublicKey(options.stateDir);
  await (options.checkPool ?? checkPoolRoutes)(options.pool);
  const store = await ReceiverState.open({ directory: receiverDirectory(options.stateDir), receiverKey: publicKey, receiverAddress: config.vpn.address, pool: options.pool });
  let runtime: Awaited<ReturnType<typeof startVpn>> | undefined;
  let stopping = false;
  let tail: Promise<unknown> = Promise.resolve();
  let reloadTimer: ReturnType<typeof setTimeout> | undefined;
  let fail!: (error: Error) => void;
  const failed = new Promise<Error>((resolve) => { fail = resolve; });
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const result = tail.then(fn);
    tail = result.catch(() => undefined);
    return result;
  };
  async function launch(): Promise<void> {
    const devices = await store.list();
    const next: PeerConfig = {
      ...config,
      peers: devices.map((device) => ({ label: device.publicKey, publicKey: device.publicKey, connection: "accept" })),
      vpn: { address: config.vpn!.address, peers: devices.map((device) => ({ peer: device.publicKey, address: device.address, allowTcp: device.allowTcp })) },
    };
    const instance = await (options.start ?? startVpn)({ stateDir: options.stateDir, config: next, helper: options.helper, log: options.log,
      enrollment: {
        enroll: (key, secret, isOpen) => serialize(async () => {
          try {
            await (options.checkPool ?? checkPoolRoutes)(options.pool, runtime?.interfaceName);
            if (stopping || !isOpen()) throw new Error("enrollment ended");
            return await store.enroll(key, secret);
          }
          catch (error) {
            if (error instanceof ReceiverStorageError) fail(new Error("receiver storage failed"));
            if (error instanceof ReceiverRouteConflict) throw new EnrollmentRejected("route");
            throw error;
          }
        }),
        changed: () => {
          // Allow the authenticated enrollment response to drain before stopping
          // its generation. A lost response still means an unknown outcome.
          if (reloadTimer) clearTimeout(reloadTimer);
          reloadTimer = setTimeout(() => {
            void serialize(async () => { if (!stopping) await restart(); }).catch(() => fail(new Error("receiver could not apply enrollment")));
          }, 250);
        },
      },
    });
    runtime = instance;
    void instance.failed.then((error) => { if (!stopping && runtime === instance) fail(error); });
  }
  async function restart(): Promise<void> {
    const old = runtime; runtime = undefined;
    await old?.stop();
    await launch();
  }
  async function command(request: Request): Promise<unknown> {
    if (request.action === "invite" && (Object.keys(request).sort().join(",") === "action" || (Object.keys(request).sort().join(",") === "action,excludeAddress" && typeof request.excludeAddress === "string"))) return { invitation: await store.createInvitation(request.excludeAddress) };
    if (request.action === "list" && Object.keys(request).length === 1) return { devices: await store.list() };
    if ((request.action === "grant" || request.action === "revoke") && typeof request.key === "string") {
      if (request.action === "grant" && Object.keys(request).sort().join(",") !== "action,key,ports") throw new Error("invalid request");
      if (request.action === "revoke" && Object.keys(request).sort().join(",") !== "action,key") throw new Error("invalid request");
      if (!/^[0-9a-f]{64}$/.test(request.key) || !(await store.list()).some((device) => device.publicKey === request.key)) throw new Error("unknown receiver device");
      if (request.action === "grant" && request.ports !== "all" && (!Array.isArray(request.ports) || request.ports.length > 256 ||
          request.ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65535) || new Set(request.ports).size !== request.ports.length)) throw new Error("invalid TCP grant");
      // Stop before changing a grant, so no preexisting flow can bypass it.
      const old = runtime; runtime = undefined;
      await old?.stop();
      try {
        if (request.action === "grant") await store.grant(request.key, request.ports!);
        else await store.revoke(request.key);
        await launch();
      } catch (error) {
        fail(new Error("receiver stopped while applying device policy"));
        throw error;
      }
      return { ok: true };
    }
    throw new Error("invalid request");
  }
  let active = 0;
  const clients = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    if (active >= 8 || stopping) { socket.destroy(); return; }
    active++; clients.add(socket);
    socket.setTimeout(10_000, () => socket.destroy());
    socket.on("error", () => undefined);
    socket.once("close", () => { active--; clients.delete(socket); });
    let data = "", handling = false;
    socket.on("data", (chunk: Buffer) => {
      if (handling) { socket.destroy(); return; }
      data += chunk.toString("utf8");
      if (Buffer.byteLength(data) > 4096) { socket.destroy(); return; }
      const end = data.indexOf("\n");
      if (end < 0) return;
      handling = true;
      void serialize(async () => {
        let request: unknown;
        try { request = JSON.parse(data.slice(0, end)) as unknown; } catch { throw new Error("invalid request"); }
        if (!request || typeof request !== "object" || Array.isArray(request) || data.slice(end + 1).length) throw new Error("invalid request");
        return command(request as Request);
      }).then((result) => socket.end(`${JSON.stringify({ result })}\n`), (error: unknown) => {
        if (error instanceof ReceiverStorageError) fail(new Error("receiver storage failed"));
        const reason = error instanceof InvitationExclusionError ? error.reason : "failed";
        socket.end(`${JSON.stringify({ error: reason })}\n`);
      });
    });
  });
  const sock = socketPath(options.stateDir);
  try {
    await launch();
    try {
      const info = await lstat(sock);
      if (!info.isSocket() || (typeof process.getuid === "function" && info.uid !== process.getuid())) throw new Error("unsafe receiver control socket");
      await unlink(sock);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(sock, () => { server.off("error", reject); resolve(); }); });
    server.on("error", () => fail(new Error("receiver control socket failed")));
  } catch (error) { await runtime?.stop(); throw error; }
  let stopTask: Promise<void> | undefined;
  return { failed, stop: () => {
    stopTask ??= (async () => {
      stopping = true;
      if (reloadTimer) clearTimeout(reloadTimer);
      for (const client of clients) client.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await tail;
      await runtime?.stop();
      await unlink(sock).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    })();
    return stopTask;
  } };
}

export async function receiverRequest(stateDir: string, request: Request): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath(stateDir));
    let data = "";
    socket.setTimeout(10_000, () => socket.destroy());
    socket.on("error", () => reject(new Error("receiver control unavailable")));
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk: Buffer) => {
      data += chunk.toString("utf8");
      if (Buffer.byteLength(data) > 32_768) socket.destroy();
    });
    socket.on("end", () => {
      try {
        const reply: unknown = JSON.parse(data);
        if (reply && typeof reply === "object" && "error" in reply) {
          if (reply.error === "invalid") { reject(new Error("Excluded address must be a usable pool address different from the receiver address")); return; }
          if (reply.error === "allocated") { reject(new Error("Excluded address is assigned to an authorized device; inspect devices and revoke the affected device first")); return; }
        }
        if (!reply || typeof reply !== "object" || !("result" in reply)) throw new Error();
        resolve(reply.result);
      } catch { reject(new Error("receiver request failed")); }
    });
    socket.on("close", () => { if (!socket.readableEnded) reject(new Error("receiver control unavailable")); });
  });
}
