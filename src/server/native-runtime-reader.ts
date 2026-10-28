import { randomUUID } from "node:crypto";
import WebSocket from "ws";

export class RuntimeReader {
  private socket?: WebSocket;
  private connecting?: Promise<void>;
  private sequence = 0;
  private pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  readonly url: string;

  constructor(url: string, private timeoutMs = 5000) {
    const parsed = new URL(url);
    if (parsed.protocol !== "ws:" || !["127.0.0.1", "[::1]", "localhost"].includes(parsed.hostname) || parsed.username || parsed.password || parsed.hash) {
      throw Error("Native runtime observers require a loopback WebSocket URL");
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

  async request(method: string, params: any): Promise<any> {
    await this.connect();
    const socket = this.socket!;
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id); reject(Error("Native runtime read timed out"));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ type: "renderer-command", seq: ++this.sequence, payload: {
        type: "ipc-renderer-invoke", requestId: randomUUID(), channel: "codex_desktop:message-from-view",
        args: [{ type: "mcp-request", hostId: "local", request: { id, method, params } }], sourceUrl: new URL(this.url).origin.replace("ws:", "http:"),
      } }), error => { if (error) this.disconnected(socket, error); });
    });
  }

  close() { if (this.socket) this.disconnected(this.socket, Error("Native observer closed")); }
}
