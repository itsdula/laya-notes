import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { decodeOtlpLogs, type MonitorRecord } from "./records.ts";

const HOST = "127.0.0.1";
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const BACKLOG = 5000;
/** A custom header makes browsers preflight, so other sites cannot press the monitor's buttons. */
export const CONTROL_HEADER = "x-laya-dev";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
};

/** Listens on the preferred port, or the next free one. */
export async function listen(server: Server, preferred: number): Promise<number> {
  for (let port = preferred; port < preferred + 50; port++) {
    const bound = await new Promise<boolean>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException) => {
        server.off("listening", onListening);
        if (error.code === "EADDRINUSE") resolve(false);
        else reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve(true);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, HOST);
    });
    if (bound) return port;
  }
  throw new Error(`No free port between ${preferred} and ${preferred + 49}.`);
}

function send(response: ServerResponse, status: number, body: string | Buffer, type = "text/plain; charset=utf-8"): void {
  response.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" });
  response.end(body);
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body too large.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Serves a folder of static files. `transform` can rewrite HTML before it is sent. */
export function staticSite(root: string, transform: (html: string) => string = (html) => html): Server {
  return createServer(async (request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") return send(response, 405, "Method not allowed");
    try {
      const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
      const file = path.resolve(root, `.${pathname.endsWith("/") ? `${pathname}index.html` : pathname}`);
      if (file !== root && !file.startsWith(root + path.sep)) return send(response, 403, "Forbidden");
      const extension = path.extname(file);
      const content = await readFile(file);
      send(response, 200, extension === ".html" ? transform(content.toString("utf8")) : content, TYPES[extension] ?? "application/octet-stream");
    } catch {
      send(response, 404, "Not found");
    }
  });
}

export type AppStatus = { state: "starting" | "running" | "restarting" | "stopped"; exitCode?: number | null; since: number };

type MonitorOptions = {
  page: string;
  onRestart: () => void;
  onStop: () => void;
};

export type Monitor = {
  server: Server;
  setStatus: (status: AppStatus) => void;
  closeClients: () => void;
};

/**
 * The monitor: an OTLP/HTTP logs receiver at /v1/logs, a live stream of what it received at /events,
 * and the page that shows it.
 */
export function monitorServer({ page, onRestart, onStop }: MonitorOptions): Monitor {
  const backlog: MonitorRecord[] = [];
  const clients = new Set<ServerResponse>();
  let status: AppStatus = { state: "starting", since: Date.now() };
  let lastId = 0;
  const nextId = () => ++lastId;

  const broadcast = (event: string, data: unknown) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of clients) client.write(frame);
  };

  const server = createServer(async (request, response) => {
    const { pathname } = new URL(request.url ?? "/", "http://localhost");
    try {
      if (request.method === "POST" && pathname === "/v1/logs") {
        if (!String(request.headers["content-type"] ?? "").includes("json")) return send(response, 415, "Send OTLP as JSON.");
        const records = decodeOtlpLogs(JSON.parse(await readBody(request)), nextId);
        backlog.push(...records);
        if (backlog.length > BACKLOG) backlog.splice(0, backlog.length - BACKLOG);
        if (records.length) broadcast("records", records);
        return send(response, 200, "{}", "application/json");
      }
      if (request.method === "GET" && pathname === "/events") {
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        response.write(`event: status\ndata: ${JSON.stringify(status)}\n\n`);
        response.write(`event: records\ndata: ${JSON.stringify(backlog)}\n\n`);
        clients.add(response);
        request.on("close", () => clients.delete(response));
        return;
      }
      if (request.method === "POST" && (pathname === "/api/restart" || pathname === "/api/stop")) {
        if (request.headers[CONTROL_HEADER] !== "1") return send(response, 403, "Forbidden");
        if (pathname === "/api/restart") onRestart();
        else onStop();
        return send(response, 202, "{}", "application/json");
      }
      if (request.method === "GET" && (pathname === "/" || pathname === "/index.html")) return send(response, 200, page, TYPES[".html"]);
      send(response, 404, "Not found");
    } catch (error) {
      send(response, 400, error instanceof Error ? error.message : "Bad request");
    }
  });

  return {
    server,
    setStatus(next) {
      status = next;
      broadcast("status", status);
    },
    closeClients() {
      for (const client of clients) client.end();
      clients.clear();
    },
  };
}
