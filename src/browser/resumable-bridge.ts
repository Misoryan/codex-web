type State = "connecting" | "ready" | "offline" | "expired";
function documentId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 15) | 64;
  bytes[8] = (bytes[8]! & 63) | 128;
  const s = Array.from(bytes, (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}
export class ResumableBridge {
  private socket: WebSocket | null = null;
  private epoch: string | null = null;
  private ack = 0;
  private next = 0;
  private sent = 0;
  private bytes = 0;
  private pending = new Map<number, { payload: unknown; size: number }>();
  private stopped = false;
  private connected = false;
  private retry = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private watchdog: ReturnType<typeof setTimeout> | undefined;
  private heartbeat: ReturnType<typeof setInterval>;
  private ping = 0;
  private waitingPing: number | null = null;
  private document = documentId();

  constructor(
    private session: string,
    private query: string,
    private receive: (message: any) => void,
    private encode: (message: any) => unknown,
    private status: (state: State, reason?: string) => void,
  ) {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        this.connect();
        this.probe();
      } else {
        this.clearWatchdog();
        this.waitingPing = null;
      }
    });
    window.addEventListener("online", () => {
      this.connect();
      this.probe();
    });
    window.addEventListener("offline", () => this.socket?.close(1000, "Network offline"));
    // A bfcache return keeps the document and its native IPC ports alive.
    window.addEventListener("pagehide", (event) => {
      if (!event.persisted) {
        this.stopped = true;
        clearInterval(this.heartbeat);
        clearTimeout(this.retryTimer);
        this.clearWatchdog();
      }
      this.socket?.close(1000, event.persisted ? "Page suspended" : "Document closed");
    });
    window.addEventListener("pageshow", () => {
      this.connect();
      this.probe();
    });
    this.heartbeat = setInterval(() => {
      if (document.visibilityState === "visible") {
        this.connect();
        this.probe();
      }
    }, 10_000);
    this.connect();
  }

  send(payload: unknown) {
    if (this.stopped) throw Error("页面连接已过期，请重新加载");
    const size = new TextEncoder().encode(JSON.stringify(payload)).length;
    if (this.bytes + size > 32 * 1024 * 1024 || this.pending.size >= 4096) {
      this.fail("待确认请求过多，请重新加载");
      throw Error("Renderer command queue exceeded");
    }
    this.pending.set(++this.next, { payload, size });
    this.bytes += size;
    this.flush();
    this.connect();
  }
  private confirm(seq: number) {
    if (!Number.isSafeInteger(seq) || seq < 0 || seq > this.next)
      throw Error("Invalid command acknowledgement");
    for (const [id, item] of this.pending) {
      if (id > seq) break;
      this.bytes -= item.size;
      this.pending.delete(id);
    }
  }
  private flush() {
    if (!this.connected || this.socket?.readyState !== WebSocket.OPEN) return;
    for (const [seq, item] of this.pending) {
      if (seq <= this.sent) continue;
      this.socket.send(
        JSON.stringify({
          type: "renderer-command",
          seq,
          payload: this.encode(item.payload),
        }),
      );
      this.sent = seq;
    }
  }
  private fail(reason: string) {
    if (this.stopped) return;
    this.stopped = true;
    this.connected = false;
    clearTimeout(this.retryTimer);
    this.clearWatchdog();
    clearInterval(this.heartbeat);
    this.status("expired", reason);
    this.socket?.close(1000, "Renderer state invalid");
    // No replay into a new server epoch. Keep the DOM and drafts for the user.
  }
  private probe() {
    if (
      this.stopped ||
      !this.connected ||
      this.socket?.readyState !== WebSocket.OPEN ||
      this.waitingPing !== null
    )
      return;
    const socket = this.socket;
    this.waitingPing = ++this.ping;
    socket.send(
      JSON.stringify({ type: "renderer-ping", id: this.waitingPing }),
    );
    this.armWatchdog(socket, "Heartbeat timeout");
  }
  private armWatchdog(socket: WebSocket, reason: string) {
    this.clearWatchdog();
    // Replies share the application queue. Incoming frames prove that it is
    // still progressing while a large upload, history page or replay drains.
    this.watchdog = setTimeout(() => {
      if (this.socket !== socket || this.stopped) return;
      this.watchdog = undefined;
      this.socket = null;
      this.connected = false;
      this.waitingPing = null;
      socket.close(1000, reason);
      this.schedule();
    }, 30_000);
  }
  private clearWatchdog() {
    clearTimeout(this.watchdog);
    this.watchdog = undefined;
  }
  private connect() {
    if (
      this.stopped ||
      document.visibilityState === "hidden" ||
      !navigator.onLine
    )
      return;
    if (
      this.socket &&
      (this.socket.readyState === WebSocket.OPEN ||
        this.socket.readyState === WebSocket.CONNECTING)
    ) {
      if (!this.connected && this.watchdog === undefined)
        this.armWatchdog(this.socket, "Handshake timeout");
      return;
    }
    clearTimeout(this.retryTimer);
    this.clearWatchdog();
    this.waitingPing = null;
    this.status("connecting");
    this.connected = false;
    this.sent = 0;
    const params = new URLSearchParams({
      lifecycle: "3",
      session: this.session,
      document: this.document,
      ack: String(this.ack),
    });
    if (this.epoch) params.set("epoch", this.epoch);
    const socket = new WebSocket(
      `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/__backend/ipc?${params}${this.query}`,
    );
    this.socket = socket;
    this.armWatchdog(socket, "Handshake timeout");
    socket.addEventListener("message", (event) => {
      if (this.socket !== socket || this.stopped) return;
      try {
        const frame = JSON.parse(String(event.data));
        if (!this.connected || this.waitingPing !== null)
          this.armWatchdog(socket, this.connected ? "Heartbeat timeout" : "Handshake timeout");
        if (frame.type === "statsig-cache-hint") {
          this.receive(frame);
          return;
        }
        if (frame.type === "renderer-reset") {
          this.fail(frame.reason);
          return;
        }
        if (frame.type === "renderer-ready") {
          if (
            typeof frame.epoch !== "string" ||
            (this.epoch && this.epoch !== frame.epoch)
          )
            throw Error("Server epoch changed");
          this.epoch = frame.epoch;
          this.confirm(frame.clientAck);
          this.sent = frame.clientAck;
          return;
        }
        if (frame.type === "renderer-event") {
          if (!this.epoch || !Number.isSafeInteger(frame.seq))
            throw Error("Invalid event");
          if (frame.seq <= this.ack) return;
          if (frame.seq !== this.ack + 1) throw Error("Missing event");
          this.receive(frame.payload);
          this.ack = frame.seq;
          socket.send(JSON.stringify({ type: "renderer-ack", seq: this.ack }));
          return;
        }
        if (frame.type === "renderer-caught-up") {
          if (!this.epoch || frame.head !== this.ack)
            throw Error("Incomplete replay");
          this.clearWatchdog();
          this.retry = 0;
          this.connected = true;
          this.status("ready");
          this.flush();
          this.probe();
          return;
        }
        if (frame.type === "renderer-command-ack") {
          this.confirm(frame.seq);
          return;
        }
        if (frame.type === "renderer-pong") {
          // A reply can arrive after hiding canceled its watchdog, or after
          // returning to the page started a newer probe on the same socket.
          if (frame.id === this.waitingPing) {
            this.clearWatchdog();
            this.waitingPing = null;
          }
          return;
        }
        throw Error("Unexpected server frame");
      } catch (error) {
        console.error("[renderer-resume]", error);
        this.fail("恢复数据不完整，请重新加载");
      }
    });
    socket.addEventListener("close", (event) => {
      if (this.socket !== socket || this.stopped) return;
      this.socket = null;
      this.connected = false;
      this.waitingPing = null;
      this.clearWatchdog();
      if (event.code === 4001) {
        this.fail("页面连接已被替换，请重新加载");
        return;
      }
      this.status("offline");
      this.schedule();
    });
    socket.addEventListener("error", () => {
      /* close or handshake deadline drives retry */
    });
  }
  private schedule() {
    if (this.stopped) return;
    this.status("offline");
    if (document.visibilityState === "hidden") return;
    this.retryTimer = setTimeout(
      () => this.connect(),
      Math.min(1000 * 2 ** this.retry++, 10_000),
    );
  }
}

export function showConnectionState(state: State, reason?: string) {
  window.dispatchEvent(new CustomEvent("codex-connection-state", { detail: { state, reason } }));
  const render = () => {
    let banner = document.getElementById("codex-connection-status");
    if (state === "ready") {
      banner?.remove();
      document.getElementById("root")?.removeAttribute("inert");
      return;
    }
    if (!banner) {
      banner = document.createElement("div");
      banner.id = "codex-connection-status";
      banner.setAttribute("role", "status");
      banner.style.cssText =
        "position:fixed;top:44px;left:50%;transform:translateX(-50%);z-index:2147483647;max-width:calc(100vw - 32px);box-sizing:border-box;padding:10px 16px;border-radius:10px;background:#292929;color:#fff;box-shadow:0 4px 20px #0004;font:13px system-ui";
      document.body.append(banner);
    }
    banner.textContent =
      state === "expired"
        ? `${reason}。未发送内容仍在页面中。`
        : state === "connecting"
          ? "正在恢复连接…"
          : "连接已暂停，联网后自动恢复…";
    // Preserve drafts but prevent actions against stale approvals/connection state.
    const root = document.getElementById("root");
    if (state === "expired") root?.removeAttribute("inert");
    else root?.setAttribute("inert", "");
    if (state === "expired") {
      const button = document.createElement("button");
      button.textContent = "重新加载";
      button.style.cssText = "margin-left:12px;padding:4px 8px";
      button.onclick = () => location.reload();
      banner.append(button);
    }
  };
  if (document.body) render();
  else document.addEventListener("DOMContentLoaded", render, { once: true });
}
