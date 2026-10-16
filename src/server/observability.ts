import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import type { IncomingMessage } from "node:http";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { WebSocket } from "ws";

type Fields = Record<string, string | number | boolean | undefined>;

// Pino supplies JSON encoding; this destination bounds disk and queued writes.
export class MonitoringDestination {
  private stream?: fs.WriteStream;
  private date = "";
  private bytes = 0;
  private part = 0;
  private retryAt = 0;
  private dropped = 0;
  private closed = false;
  constructor(readonly directory: string) {}
  write(line: string): void {
    if (this.closed) return;
    if (Date.now() < this.retryAt) { this.dropped++; return; }
    const date = new Date().toISOString().slice(0, 10);
    try {
      if (!this.stream || this.date !== date || this.bytes >= 10 * 1024 * 1024) {
        this.stream?.end();
        if (this.date !== date) this.part = 0;
        this.date = date;
        fs.mkdirSync(this.directory, { recursive: true });
        const file = path.join(this.directory, `server-${date}-${process.pid}-${this.part++}.jsonl`);
        this.bytes = fs.existsSync(file) ? fs.statSync(file).size : 0;
        const stream = this.stream = fs.createWriteStream(file, { flags: "a" });
        stream.on("error", () => {
          if (this.stream === stream) this.stream = undefined;
          this.retryAt = Date.now() + 60_000;
          console.warn("[monitoring] log file unavailable; retrying in 60 seconds");
        });
        const old = fs.readdirSync(this.directory).filter(name => /^server-.*\.jsonl$/.test(name))
          .map(name => ({ name, time: fs.statSync(path.join(this.directory, name)).mtimeMs }))
          .sort((a, b) => b.time - a.time);
        for (const entry of old.slice(7)) if (path.join(this.directory, entry.name) !== file)
          fs.unlinkSync(path.join(this.directory, entry.name));
      }
      if (this.stream.writableLength > 1024 * 1024) { this.dropped++; return; }
      this.bytes += Buffer.byteLength(line);
      this.stream.write(line);
    } catch {
      this.retryAt = Date.now() + 60_000;
      this.dropped++;
      console.warn("[monitoring] log destination unavailable; retrying in 60 seconds");
    }
  }
  get droppedRecords(): number { return this.dropped; }
  async close(): Promise<void> {
    this.closed = true;
    const stream = this.stream;
    this.stream = undefined;
    if (stream && !stream.destroyed) await new Promise<void>(resolve => stream.end(resolve));
  }
}

export function identity(value: string | null | undefined): string | undefined {
  return value ? createHash("sha256").update(value).digest("hex").slice(0, 16) : undefined;
}

export function errorFields(error: unknown): Fields {
  const value = error as { name?: unknown; code?: unknown } | null;
  return {
    errorType: typeof value?.name === "string" && /^[A-Za-z][A-Za-z0-9]{0,50}$/.test(value.name) ? value.name : "Error",
    errorCode: typeof value?.code === "string" && /^[A-Z0-9_]{1,64}$/.test(value.code) ? value.code : undefined,
  };
}

export function requestFields(request: IncomingMessage): Fields {
  const url = new URL(request.url || "/", "http://localhost");
  const pathname = url.pathname;
  const referer = String(request.headers.referer || "");
  const mode = request.headers.upgrade && !referer ? undefined
    : pathname.startsWith("/lite") || referer.includes("/lite/") ? "lite" : "full";
  const route = pathname === "/" ? "/" : pathname === "/lite" || pathname === "/lite/" ? "/lite/"
    : /^\/__backend\/(ipc|browser-stream|upload|telemetry|health)$/.test(pathname) ? pathname
    : /^\/(lite\/)?assets\/[A-Za-z0-9_.-]+$/.test(pathname) ? pathname
    : pathname.startsWith("/@fs/") ? "/@fs/*"
    : pathname.startsWith("/lite/thread/") ? "/lite/thread/*"
    : pathname.startsWith("/thread/") ? "/thread/*"
    : ["/lite/sw.js", "/lite/manifest.webmanifest", "/favicon.svg"].includes(pathname) ? pathname : "/other";
  const agent = String(request.headers["user-agent"] || "");
  return {
    path: route, mode,
    platform: /Android/i.test(agent) ? "android" : /iPhone|iPad/i.test(agent) ? "ios" : /Windows/i.test(agent) ? "windows" : "other",
    source: /^(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?\/?$/.test(String(request.headers.origin || request.headers.host || "")) ? "local" : "public",
  };
}

const closeReasons = new Set(["Document closed", "Page suspended", "Network offline", "Heartbeat timeout", "Handshake timeout", "Renderer state invalid", "Renderer reset required", "Renderer connection replaced"]);

export class ServerMonitoring {
  readonly runId = randomUUID();
  readonly connections = { ipc: 0, stream: 0 };
  constructor(private logger: FastifyBaseLogger) {}
  event(event: string, fields: Fields = {}): void { this.logger.info({ event, runId: this.runId, ...fields }); }
  connection(kind: string, socket: WebSocket, request: IncomingMessage) {
    const counter = kind as keyof typeof this.connections;
    this.connections[counter]++;
    const params = new URL(request.url || "/", "http://localhost").searchParams;
    const context = { connectionId: randomUUID(), ...requestFields(request),
      session: identity(params.get("session")), document: identity(params.get("document")),
      guest: identity(params.get("token")) };
    const start = performance.now();
    let receivedBytes = 0, messages = 0, pongs = 0, lastPongAt = Date.now();
    const event = (name: string, fields: Fields = {}) => this.event(`${kind}.${name}`, { ...context, ...fields });
    event("open", { lifecycle: params.get("lifecycle") === "3" ? "3" : "invalid", resumeRequested: !!params.get("epoch") });
    socket.on("message", raw => { receivedBytes += Array.isArray(raw) ? raw.reduce((sum, part) => sum + part.length, 0) : raw.byteLength; messages++; });
    socket.on("pong", () => { pongs++; lastPongAt = Date.now(); });
    socket.on("error", error => event("error", errorFields(error)));
    const sample = setInterval(() => event("sample", { durationMs: Math.round(performance.now() - start), receivedBytes, messages, pongs, lastPongAgeMs: Date.now() - lastPongAt, bufferedBytes: socket.bufferedAmount }), 60_000);
    sample.unref();
    socket.once("close", (code, reason) => {
      this.connections[counter]--;
      clearInterval(sample);
      const text = reason.toString();
      event("close", { code, reason: !text || closeReasons.has(text) ? text : "other", reasonHash: text && !closeReasons.has(text) ? identity(text) : undefined,
        durationMs: Math.round(performance.now() - start), receivedBytes, messages, pongs });
    });
    return { event };
  }
}

export function installHttpMonitoring(app: FastifyInstance, monitoring: ServerMonitoring): void {
  const delay = monitorEventLoopDelay({ resolution: 20 });
  delay.enable();
  app.server.once("listening", () => monitoring.event("server.start"));
  const sample = setInterval(() => {
    monitoring.event("server.sample", { rssBytes: process.memoryUsage().rss,
      eventLoopP99Ms: Math.round(delay.percentile(99) / 1e6), eventLoopMaxMs: Math.round(delay.max / 1e6),
      ipcConnections: monitoring.connections.ipc, streamConnections: monitoring.connections.stream });
    delay.reset();
  }, 60_000);
  sample.unref();
  app.addHook("onClose", async () => { clearInterval(sample); delay.disable(); });
  app.addHook("onRequest", async request => {
    monitoring.event("http.start", { requestId: request.id, method: request.method, ...requestFields(request.raw) });
  });
  app.addHook("onResponse", async (request, reply) => {
    monitoring.event("http.complete", { requestId: request.id, method: request.method, ...requestFields(request.raw), status: reply.statusCode, durationMs: Math.round(reply.elapsedTime) });
  });
  app.addHook("onRequestAbort", async request => {
    monitoring.event("http.abort", { requestId: request.id, method: request.method, ...requestFields(request.raw) });
  });
  app.addHook("onError", async (request, reply, error) => {
    monitoring.event("http.error", { requestId: request.id, ...requestFields(request.raw), status: reply.statusCode, ...errorFields(error) });
  });
  app.server.on("clientError", error => monitoring.event("http.client_error", errorFields(error)));
}
