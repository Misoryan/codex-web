import { randomUUID } from "node:crypto";
import WebSocket from "ws";

export type RuntimeState = { runtime: string; activeFlags: string[]; pending: number };
export type RuntimeBatch = { available: boolean; states: Map<string, RuntimeState> };

export function runtimeState(status: any): RuntimeState {
  const runtime = ["active", "idle", "notLoaded", "systemError"].includes(status?.type) ? status.type : "unknown";
  const activeFlags: string[] = runtime === "active" && Array.isArray(status.activeFlags)
    ? status.activeFlags.filter((flag: unknown): flag is string => typeof flag === "string") : [];
  return { runtime, activeFlags, pending: activeFlags.some(flag => ["waitingOnApproval", "waitingOnUserInput"].includes(flag)) ? 1 : 0 };
}

export async function readLoadedRuntime(
  threadIds: readonly string[],
  request: (method: string, params: any) => Promise<any>,
): Promise<RuntimeBatch> {
  const states = new Map<string, RuntimeState>();
  try {
    const relevant = new Set(threadIds), loaded = new Set<string>();
    let cursor: string | null = null;
    do {
      const page = await request("thread/loaded/list", { cursor, limit: 100 });
      if (!Array.isArray(page?.data)) throw Error("Native loaded thread list is unavailable");
      for (const id of page.data) if (typeof id === "string" && relevant.has(id)) loaded.add(id);
      cursor = page.nextCursor ?? null;
    } while (cursor);
    await Promise.all([...loaded].map(async threadId => {
      try {
        const response = await request("thread/read", { threadId, includeTurns: false });
        states.set(threadId, runtimeState(response?.thread?.status));
      } catch { states.set(threadId, runtimeState(null)); }
    }));
    return { available: true, states };
  } catch { return { available: false, states }; }
}

export class RuntimeReader {
  private socket?: WebSocket;
  private connecting?: Promise<void>;
  private sequence = 0;
  private pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  readonly url: string;

  constructor(url: string, private timeoutMs = 5000) {
    const parsed = new URL(url);
    if (parsed.protocol !== "ws:" || !["127.0.0.1", "[::1]", "localhost"].includes(parsed.hostname) || parsed.username || parsed.password || parsed.hash) {
      throw Error("Workflow runtime observers require a loopback WebSocket URL");
    }
    this.url = parsed.href;
  }

  private connect(): Promise<void> {
    if (this.connecting) return this.connecting;
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve();
    const url = new URL(this.url);
    url.searchParams.set("lifecycle", "3");
    url.searchParams.set("session", randomUUID());
    url.searchParams.set("document", randomUUID());
    url.searchParams.set("ack", "0");
    this.sequence = 0;
    const socket = new WebSocket(url, { maxPayload: 32 * 1024 * 1024 });
    this.socket = socket;
    const promise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => fail(Error("Native observer handshake timed out")), this.timeoutMs);
      const fail = (error: Error) => { clearTimeout(timer); reject(error); this.disconnected(socket, error); };
      socket.on("error", fail);
      socket.on("close", () => fail(Error("Native observer disconnected")));
      socket.on("message", raw => {
        try {
          const frame = JSON.parse(raw.toString());
          if (frame.type === "renderer-reset") throw Error("Native observer session expired");
          if (frame.type === "renderer-ready") { clearTimeout(timer); resolve(); return; }
          if (frame.type !== "renderer-event") return;
          socket.send(JSON.stringify({ type: "renderer-ack", seq: frame.seq }));
          if (frame.payload?.type !== "ipc-main-event") return;
          for (const argument of frame.payload.args ?? []) {
            if (argument?.type !== "mcp-response") continue;
            const response = argument.message, waiter = this.pending.get(response?.id);
            if (!waiter) continue;
            this.pending.delete(response.id); clearTimeout(waiter.timer);
            if (response.error) waiter.reject(Error("Native runtime read failed"));
            else waiter.resolve(response.result);
          }
        } catch (error) { fail(error as Error); }
      });
    });
    this.connecting = promise;
    void promise.finally(() => { if (this.connecting === promise) this.connecting = undefined; }).catch(() => {});
    return promise;
  }

  private disconnected(socket: WebSocket, error: Error) {
    if (this.socket !== socket) return;
    this.socket = undefined;
    for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(error); }
    this.pending.clear();
    if (socket.readyState === WebSocket.OPEN) socket.close(1000, "Document closed");
    else socket.terminate();
  }

  private async request(method: string, params: any): Promise<any> {
    await this.connect();
    const socket = this.socket!;
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id); reject(Error("Native runtime read timed out"));
        this.disconnected(socket, Error("Native runtime read timed out"));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ type: "renderer-command", seq: ++this.sequence, payload: {
        type: "ipc-renderer-invoke", requestId: randomUUID(), channel: "codex_desktop:message-from-view",
        args: [{ type: "mcp-request", hostId: "local", request: { id, method, params } }], sourceUrl: new URL(this.url).origin.replace("ws:", "http:"),
      } }), error => { if (error) this.disconnected(socket, error); });
    });
  }

  snapshot(threadIds: readonly string[]) { return readLoadedRuntime(threadIds, (method, params) => this.request(method, params)); }
  close() { if (this.socket) this.disconnected(this.socket, Error("Native observer closed")); }
}
