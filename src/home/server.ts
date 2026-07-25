import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";

import {
  createHomeRegistry,
  type HomeRegistry,
  type HomeRegistryService,
} from "./registry.js";

const host = "127.0.0.1" as const;
const registryPath = "/.well-known/kepos/services.json";
const benchmarkPath = "/.well-known/kepos/benchmark";
const benchmarkChunk = Buffer.alloc(64 * 1024);
const maxBenchmarkBytes = 64 * 1024 * 1024;

export interface RunningHomeServer {
  host: typeof host;
  port: number;
  url: string;
  close: () => Promise<void>;
}

export interface StartHomeServerOptions {
  publisherKey: string;
  port?: number;
  displayName?: string;
  services?: HomeRegistryService[];
}

function send(
  response: ServerResponse,
  statusCode: number,
  contentType: string,
  body: string | Buffer,
  headers: Record<string, string> = {},
): void {
  response.writeHead(statusCode, {
    "content-type": contentType,
    ...headers,
  });
  response.end(body);
}

async function sendBenchmark(response: ServerResponse, bytes: number): Promise<void> {
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-length": String(bytes),
    "content-type": "application/octet-stream",
    "x-kepos-benchmark-bytes": String(bytes),
  });

  let remaining = bytes;
  while (remaining > 0) {
    const size = Math.min(remaining, benchmarkChunk.byteLength);
    if (!response.write(benchmarkChunk.subarray(0, size))) {
      await once(response, "drain");
    }
    remaining -= size;
  }
  response.end();
}

export async function startHomeServer({
  publisherKey,
  port = 0,
  displayName = "Local Publisher",
  services = [],
}: StartHomeServerOptions): Promise<RunningHomeServer> {
  const registry = createHomeRegistry({
    publisherKey,
    displayName,
    services,
  });
  return startHomeServerWithRegistry(registry, port);
}

async function startHomeServerWithRegistry(
  registry: HomeRegistry,
  port: number,
): Promise<RunningHomeServer> {
  const registryBody = `${JSON.stringify(registry, null, 2)}\n`;
  const registryEtag = `"${createHash("sha256").update(registryBody).digest("hex")}"`;

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const { pathname } = url;

    if (request.method !== "GET") {
      send(response, 404, "text/plain; charset=utf-8", "Not Found\n");
      return;
    }
    if (pathname === registryPath) {
      if (request.headers["if-none-match"] === registryEtag) {
        response.writeHead(304, { etag: registryEtag });
        response.end();
        return;
      }

      send(
        response,
        200,
        "application/json; charset=utf-8",
        registryBody,
        { etag: registryEtag },
      );
      return;
    }
    if (pathname === "/healthz") {
      send(response, 200, "text/plain; charset=utf-8", "ok\n");
      return;
    }
    if (pathname === benchmarkPath) {
      const rawBytes = url.searchParams.get("bytes");
      const bytes = Number(rawBytes);
      if (
        rawBytes === null ||
        !/^\d+$/.test(rawBytes) ||
        !Number.isSafeInteger(bytes) ||
        bytes < 1 ||
        bytes > maxBenchmarkBytes
      ) {
        send(response, 400, "text/plain; charset=utf-8", "bytes must be an integer from 1 through 67108864\n");
        return;
      }

      void sendBenchmark(response, bytes).catch((error: unknown) => {
        response.destroy(error instanceof Error ? error : new Error(String(error)));
      });
      return;
    }

    send(response, 404, "text/plain; charset=utf-8", "Not Found\n");
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("Home server address is unavailable");
  }

  return {
    host,
    port: address.port,
    url: `http://${host}:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
