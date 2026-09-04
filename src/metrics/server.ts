import { createServer, type Server } from "node:http";

export interface MetricsListenAddress {
  host: string;
  port: number;
}

export interface RunningMetricsServer {
  host: string;
  port: number;
  url: string;
  close: () => Promise<void>;
}

export interface StartMetricsServerOptions {
  listen: MetricsListenAddress;
  render: () => string;
}

const metricsPath = "/metrics";
const contentType = "text/plain; version=0.0.4; charset=utf-8";

/** Start the intentionally small, read-only Prometheus scrape endpoint. */
export async function startMetricsServer(
  options: StartMetricsServerOptions,
): Promise<RunningMetricsServer> {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method !== "GET" || url.pathname !== metricsPath) {
      response.writeHead(request.method === "GET" ? 404 : 405, {
        "content-type": "text/plain; charset=utf-8",
        allow: "GET",
      });
      response.end(request.method === "GET" ? "Not Found\n" : "Method Not Allowed\n");
      return;
    }
    try {
      const body = options.render();
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-type": contentType,
      });
      response.end(body);
    } catch (error) {
      response.writeHead(500, {
        "content-type": "text/plain; charset=utf-8",
      });
      response.end(`Metrics rendering failed: ${errorMessage(error)}\n`);
    }
  });

  try {
    await listen(server, options.listen);
  } catch (error) {
    await closeServer(server).catch(() => undefined);
    throw error;
  }

  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("Metrics server address is unavailable");
  }
  let closed = false;
  return {
    host: options.listen.host,
    port: address.port,
    url: `http://${formatHost(options.listen.host)}:${address.port}${metricsPath}`,
    close: async () => {
      if (closed) return;
      closed = true;
      await closeServer(server);
    },
  };
}

function listen(server: Server, address: MetricsListenAddress): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(address.port, address.host);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function formatHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
