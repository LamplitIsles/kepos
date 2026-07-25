import { request } from "node:http";

import {
  createHomeRegistry,
  type HomeRegistry,
  type HomeRegistryService,
} from "../home/registry.js";

const registryPath = "/.well-known/kepos/services.json";
const maximumRegistryBytes = 64 * 1024;

export function readHomeRegistry(
  gatewayPort: number,
  timeoutMs = 5_000,
): Promise<HomeRegistry> {
  return new Promise((resolve, reject) => {
    const pending = request({
      host: "127.0.0.1",
      port: gatewayPort,
      path: registryPath,
      method: "GET",
      headers: {
        accept: "application/json",
        host: `home.localhost:${gatewayPort}`,
      },
    }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Home registry returned HTTP ${response.statusCode ?? "unknown"}`));
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
    });
    pending.setTimeout(timeoutMs, () => {
      pending.destroy(new Error("Home registry request timed out"));
    });
    pending.once("error", reject);
    pending.end();
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
