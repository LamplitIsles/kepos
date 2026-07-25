import {
  createServer,
  type Server,
  type Socket,
} from "node:net";
import type { Duplex } from "node:stream";

import {
  CancellationController,
  type CancellationSignal,
} from "../runtime/cancellation.js";
import {
  DEFAULT_GATEWAY_HOST,
  parseGatewayDomain,
  parseGatewayHost,
} from "./gateway-options.js";

export const DEFAULT_GATEWAY_PORT = 17_480;

const maximumHeaderBytes = 16 * 1024;
const headerTerminator = Buffer.from("\r\n\r\n");
const serviceIdPattern = /^[a-z][a-z0-9-]*$/;

export interface StartHttpGatewayOptions {
  port?: number;
  host?: string;
  domain?: string;
  acquisitionTimeoutMs?: number;
  open(serviceId: string, signal?: CancellationSignal): Promise<Duplex>;
}

export interface RunningHttpGateway {
  port: number;
  server: Server;
  url: string;
}

export async function startHttpGateway(
  options: StartHttpGatewayOptions,
): Promise<RunningHttpGateway> {
  const host = parseGatewayHost(
    options.host ?? DEFAULT_GATEWAY_HOST,
    "gateway host",
  );
  const domain = options.domain === undefined
    ? undefined
    : parseGatewayDomain(options.domain, "gateway domain");
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    routeSocket(
      socket,
      options.open,
      options.acquisitionTimeoutMs ?? 10_000,
      domain,
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(
      options.port ?? DEFAULT_GATEWAY_PORT,
      host,
      () => {
        server.off("error", reject);
        resolve();
      },
    );
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("HTTP gateway address is unavailable");
  }
  return {
    port: address.port,
    server,
    url: `http://home.localhost:${address.port}`,
  };
}

function routeSocket(
  socket: Socket,
  open: (serviceId: string, signal?: CancellationSignal) => Promise<Duplex>,
  acquisitionTimeoutMs: number,
  domain?: string,
): void {
  let buffered = Buffer.alloc(0);
  let tunnel: Duplex | undefined;
  socket.setTimeout(10_000, () => socket.destroy());
  socket.on("error", (error) => tunnel?.destroy(error));
  socket.on("data", onData);

  function onData(chunk: Buffer): void {
    buffered = Buffer.concat([buffered, chunk]);
    if (buffered.length > maximumHeaderBytes) {
      replyAndClose(socket, 431, "Request Header Fields Too Large");
      return;
    }
    const headerEnd = buffered.indexOf(headerTerminator);
    if (headerEnd === -1) return;

    socket.pause();
    socket.setTimeout(0);
    socket.off("data", onData);
    const serviceId = parseServiceId(
      buffered.subarray(0, headerEnd).toString("latin1"),
      domain,
    );
    if (!serviceId) {
      replyAndClose(socket, 421, "Misdirected Request");
      return;
    }
    const abort = new CancellationController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      abort.abort();
      replyAndClose(socket, 503, "Service Unavailable", {
        "Retry-After": "1",
      });
    }, acquisitionTimeoutMs);
    socket.once("close", () => abort.abort());
    void open(serviceId, abort.signal)
      .then((opened) => {
        clearTimeout(timeout);
        tunnel = opened;
        if (socket.destroyed) {
          tunnel.destroy();
          return;
        }
        socket.setTimeout(0);
        tunnel.write(buffered);
        socket.pipe(tunnel);
        tunnel.pipe(socket);
        socket.once("close", () => tunnel?.destroy());
        tunnel.once("close", () => socket.destroy());
        tunnel.once("error", (error) => socket.destroy(error));
        socket.resume();
      })
      .catch(() => {
        clearTimeout(timeout);
        if (!timedOut) replyAndClose(socket, 502, "Bad Gateway");
      });
  }
}

function parseServiceId(header: string, domain?: string): string | null {
  const hosts = header
    .split("\r\n")
    .slice(1)
    .flatMap((line) => {
      const separator = line.indexOf(":");
      if (separator === -1) return [];
      if (line.slice(0, separator).trim().toLowerCase() !== "host") {
        return [];
      }
      return [line.slice(separator + 1).trim()];
    });
  if (hosts.length !== 1) return null;
  const authority = hosts[0].toLowerCase();
  const hostname = authority.replace(/:\d+$/, "");
  const domains = domain === undefined ? ["localhost"] : ["localhost", domain];
  for (const acceptedDomain of domains) {
    const suffix = `.${acceptedDomain}`;
    if (!hostname.endsWith(suffix)) continue;
    const serviceId = hostname.slice(0, -suffix.length);
    if (serviceIdPattern.test(serviceId)) return serviceId;
  }
  return null;
}

function replyAndClose(
  socket: Socket,
  status: number,
  reason: string,
  headers: Record<string, string> = {},
): void {
  if (socket.destroyed) return;
  const encodedHeaders = Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}\r\n`)
    .join("");
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\n${encodedHeaders}Connection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
