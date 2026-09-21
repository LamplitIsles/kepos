import { request } from "node:http";
import type { Duplex } from "node:stream";

import {
  createHomeRegistry,
  HOME_REGISTRY_PATH,
  type HomeRegistry,
  type HomeRegistryService,
} from "../home/registry.js";
import { retainStreamErrors } from "./stream-errors.js";

const maximumRegistryBytes = 64 * 1024;

export class HomeRegistryTimeoutError extends Error {
  override readonly name = "HomeRegistryTimeoutError";

  constructor(timeoutMs: number) {
    super(`Home registry request timed out after ${timeoutMs}ms`);
  }
}

export function readHomeRegistry(
  gatewayPort: number,
  timeoutMs = 5_000,
): Promise<HomeRegistry> {
  return new Promise((resolve, reject) => {
    const pending = request(
      {
        host: "127.0.0.1",
        port: gatewayPort,
        path: HOME_REGISTRY_PATH,
        method: "GET",
        headers: {
          accept: "application/json",
          host: `home.localhost:${gatewayPort}`,
        },
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(
            new Error(
              `Home registry returned HTTP ${response.statusCode ?? "unknown"}`,
            ),
          );
          return;
        }

        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.byteLength;
          if (bytes > maximumRegistryBytes) {
            response.destroy(new Error("Home registry exceeds 64 KiB"));
            return;
          }
          chunks.push(chunk);
        });
        response.once("error", reject);
        response.once("end", () => {
          try {
            resolve(parseHomeRegistry(Buffer.concat(chunks).toString("utf8")));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    pending.setTimeout(timeoutMs, () => {
      pending.destroy(new HomeRegistryTimeoutError(timeoutMs));
    });
    pending.once("error", reject);
    pending.end();
  });
}

/** Read the Home registry through an already opened Kepos TCP tunnel. */
export function readHomeRegistryFromConnection(
  connection: Duplex,
  timeoutMs = 5_000,
): Promise<HomeRegistry> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const timer = setTimeout(() => {
      fail(new HomeRegistryTimeoutError(timeoutMs));
    }, timeoutMs);
    timer.unref?.();

    const finish = (error?: Error, registry?: HomeRegistry): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      connection.off("data", onData);
      connection.off("end", onEnd);
      connection.off("close", onClose);
      if (error) reject(error);
      else if (registry) resolve(registry);
      else
        reject(new Error("Home registry connection ended without a response"));
    };
    const fail = (error: Error): void => {
      finish(error);
      if (!connection.destroyed) connection.destroy(error);
    };
    const onData = (chunk: Buffer | Uint8Array): void => {
      const next = Buffer.from(chunk);
      bytes += next.byteLength;
      if (bytes > maximumRegistryBytes + 16 * 1024) {
        fail(new Error("Home registry response exceeds 80 KiB"));
        return;
      }
      chunks.push(next);
    };
    const onError = (error: Error): void => finish(error);
    const onEnd = (): void => {
      try {
        const registry = parseHomeRegistryResponse(Buffer.concat(chunks));
        finish(undefined, registry);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    };
    const onClose = (): void => {
      if (settled) return;
      try {
        const registry = parseHomeRegistryResponse(Buffer.concat(chunks));
        finish(undefined, registry);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    };

    connection.on("data", onData);
    retainStreamErrors(connection, onError);
    connection.once("end", onEnd);
    connection.once("close", onClose);
    try {
      // Keep the read half open until the Home peer closes it after its
      // response. Bare stream transports may treat end() as a full close.
      connection.write(
        Buffer.from(
          `GET ${HOME_REGISTRY_PATH} HTTP/1.1\r\nHost: home.localhost\r\nConnection: close\r\nAccept: application/json\r\n\r\n`,
          "latin1",
        ),
      );
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function parseHomeRegistry(body: string): HomeRegistry {
  const value: unknown = JSON.parse(body);
  if (!isRecord(value) || value.schemaVersion !== 2 || value.revision !== 1) {
    throw new Error("Home registry has an unsupported schema");
  }
  const publisher = value.publisher;
  const services = value.services;
  if (!isRecord(publisher) || !Array.isArray(services)) {
    throw new Error("Home registry is incomplete");
  }
  const [home, ...published] = services;
  if (
    !isRecord(home) ||
    home.id !== "home" ||
    home.name !== "Home" ||
    home.kind !== "tcp"
  ) {
    throw new Error("Home registry has no canonical Home service");
  }
  return createHomeRegistry({
    publisherKey: publisher.publisherKey as string,
    displayName: publisher.displayName as string,
    services: published as HomeRegistryService[],
  });
}

function parseHomeRegistryResponse(source: Buffer): HomeRegistry {
  const headerEnd = source.indexOf(Buffer.from("\r\n\r\n", "latin1"));
  if (headerEnd === -1 || headerEnd > 16 * 1024) {
    throw new Error("Home registry response headers are invalid");
  }
  const header = source.subarray(0, headerEnd).toString("latin1");
  const lines = header.split("\r\n");
  const status = /^HTTP\/1\.[01] (\d{3})(?: |$)/u.exec(lines.shift() ?? "");
  if (!status || Number(status[1]) !== 200) {
    throw new Error(`Home registry returned HTTP ${status?.[1] ?? "unknown"}`);
  }
  const headers = new Map<string, string>();
  for (const line of lines) {
    const separator = line.indexOf(":");
    if (separator <= 0)
      throw new Error("Home registry response has an invalid header");
    const name = line.slice(0, separator).toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (headers.has(name))
      throw new Error(`Home registry response repeats ${name}`);
    headers.set(name, value);
  }
  const encodedBody = source.subarray(headerEnd + 4);
  const transferEncoding = headers.get("transfer-encoding")?.toLowerCase();
  let body: Buffer;
  if (transferEncoding === "chunked") {
    body = decodeChunkedBody(encodedBody);
  } else {
    const contentLength = headers.get("content-length");
    if (contentLength !== undefined) {
      if (!/^\d+$/u.test(contentLength)) {
        throw new Error("Home registry content length is invalid");
      }
      const length = Number(contentLength);
      if (!Number.isSafeInteger(length) || length > maximumRegistryBytes) {
        throw new Error("Home registry exceeds 64 KiB");
      }
      if (encodedBody.byteLength !== length) {
        throw new Error("Home registry response body is incomplete");
      }
    }
    body = encodedBody;
  }
  if (body.byteLength > maximumRegistryBytes) {
    throw new Error("Home registry exceeds 64 KiB");
  }
  return parseHomeRegistry(body.toString("utf8"));
}

function decodeChunkedBody(source: Buffer): Buffer {
  const chunks: Buffer[] = [];
  let offset = 0;
  let total = 0;
  while (true) {
    const lineEnd = source.indexOf(Buffer.from("\r\n", "latin1"), offset);
    if (lineEnd === -1 || lineEnd - offset > 1_024) {
      throw new Error("Home registry chunk size is invalid");
    }
    const line = source.subarray(offset, lineEnd).toString("latin1");
    const sizeText = line.split(";", 1)[0] ?? "";
    if (!/^[0-9a-f]+$/iu.test(sizeText)) {
      throw new Error("Home registry chunk size is invalid");
    }
    const size = Number.parseInt(sizeText, 16);
    if (!Number.isSafeInteger(size) || total + size > maximumRegistryBytes) {
      throw new Error("Home registry exceeds 64 KiB");
    }
    offset = lineEnd + 2;
    if (source.byteLength < offset + size + 2) {
      throw new Error("Home registry chunk is incomplete");
    }
    if (size > 0) chunks.push(source.subarray(offset, offset + size));
    offset += size;
    if (size > 0) {
      if (source[offset] !== 0x0d || source[offset + 1] !== 0x0a) {
        throw new Error("Home registry chunk is not CRLF terminated");
      }
      offset += 2;
    }
    total += size;
    if (size !== 0) continue;
    while (true) {
      const trailerEnd = source.indexOf(Buffer.from("\r\n", "latin1"), offset);
      if (trailerEnd === -1)
        throw new Error("Home registry trailers are incomplete");
      if (trailerEnd === offset) {
        offset += 2;
        if (offset !== source.byteLength) {
          throw new Error("Home registry has bytes after its response");
        }
        return Buffer.concat(chunks, total);
      }
      if (trailerEnd - offset > 16 * 1024) {
        throw new Error("Home registry trailers are too large");
      }
      offset = trailerEnd + 2;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
