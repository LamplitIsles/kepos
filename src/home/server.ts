import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";

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
const homeTemplatePath = fileURLToPath(
  typeof import.meta.asset === "function"
    ? import.meta.asset("../../home/index.html")
    : new URL("../../home/index.html", import.meta.url),
);
const homeStylesPath = fileURLToPath(
  typeof import.meta.asset === "function"
    ? import.meta.asset("../../home/styles.css")
    : new URL("../../home/styles.css", import.meta.url),
);

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
  const [homeTemplate, homeCss] = await Promise.all([
    readFile(homeTemplatePath, "utf8"),
    readFile(homeStylesPath),
  ]);

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const { pathname } = url;

    if (request.method !== "GET") {
      send(response, 404, "text/plain; charset=utf-8", "Not Found\n");
      return;
    }
    if (pathname === "/") {
      send(
        response,
        200,
        "text/html; charset=utf-8",
        renderHomeHtml(homeTemplate, registry, request.headers.host),
      );
      return;
    }
    if (pathname === "/styles.css") {
      send(response, 200, "text/css; charset=utf-8", homeCss);
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

function renderHomeHtml(
  template: string,
  registry: HomeRegistry,
  requestHost: string | undefined,
): string {
  const publisherName = escapeHtml(registry.publisher.displayName);
  const serviceCount = `${registry.services.length} available`;
  const gatewayPort = parseRequestPort(requestHost);
  const serviceRows = registry.services
    .map((service) => {
      const description =
        service.id === "home"
          ? "The default publisher page and service directory."
          : `Published ${service.kind.toUpperCase()} service · ${escapeHtml(service.id)}`;
      const action =
        service.id === "ssh"
          ? ""
          : `<a class="btn btn-ghost btn-sm self-center whitespace-nowrap" href="${serviceUrl(service.id, gatewayPort)}">Open</a>`;
      return `<li class="list-row gap-4 px-0 py-5 sm:grid-cols-[1fr_auto]">
            <div>
              <h3 class="font-semibold">${escapeHtml(service.name)}</h3>
              <p class="mt-1 text-sm text-base-content/60">${description}</p>
            </div>
            ${action}
          </li>`;
    })
    .join("\n          ");

  return template
    .replaceAll("{{PUBLISHER_NAME}}", publisherName)
    .replace("{{SERVICE_COUNT}}", serviceCount)
    .replace("{{SERVICE_ROWS}}", serviceRows);
}

function parseRequestPort(requestHost: string | undefined): number {
  const match = requestHost?.match(/:(\d+)$/);
  if (!match) return 80;
  const port = Number(match[1]);
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : 80;
}

function serviceUrl(serviceId: string, port: number): string {
  const authority = port === 80 ? `${serviceId}.localhost` : `${serviceId}.localhost:${port}`;
  return `http://${authority}/`;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character]!,
  );
}
