type Invoke = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function installBrowserView(invoke: Invoke): void {
  if (customElements.get("codex-webview")) return;
  customElements.define("codex-webview", class extends HTMLElement {
    private canvas = document.createElement("canvas");
    private status = document.createElement("div");
    private input = document.createElement("textarea");
    private socket?: WebSocket;
    private token?: string;
    private attaching = false;
    private reconnect?: number;
    private viewTimer?: number;
    private viewState = "";
    private composing = false;
    private touch?: { x: number; y: number; moved: boolean };
    constructor() {
      super();
      const shadow = this.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = `:host{display:block;position:relative;overflow:hidden}canvas{width:100%;height:100%;display:block;touch-action:none}textarea{position:absolute;left:1px;bottom:1px;width:1px;height:1px;opacity:.01;resize:none;padding:0;border:0}div{position:absolute;inset:0;display:grid;place-items:center;padding:20px;background:#f6f6f6;color:#555;font:13px system-ui;text-align:center}div:empty{display:none}`;
      this.status.textContent = "正在连接浏览器…";
      this.input.setAttribute("aria-label", "网页输入");
      this.input.autocomplete = "off";
      this.input.spellcheck = false;
      shadow.append(style, this.canvas, this.input, this.status);
      const mouse = (event: PointerEvent | WheelEvent, type: string) => {
        event.preventDefault();
        const rect = this.canvas.getBoundingClientRect();
        this.send({ type: "mouse", event: type, x: event.clientX - rect.left, y: event.clientY - rect.top,
          button: ["left", "middle", "right"][event.button], buttons: event.buttons,
          clickCount: type === "mouseMoved" ? 0 : 1,
          ...(event instanceof WheelEvent ? { deltaX: event.deltaX, deltaY: event.deltaY } : {}),
        });
      };
      this.canvas.onpointerdown = event => {
        this.canvas.setPointerCapture(event.pointerId);
        if (event.pointerType === "touch") { event.preventDefault(); this.touch = { x: event.clientX, y: event.clientY, moved: false }; }
        else { this.input.focus({ preventScroll: true }); mouse(event, "mousePressed"); }
      };
      this.canvas.onpointerup = event => {
        if (event.pointerType === "touch") {
          if (this.touch && !this.touch.moved) { this.input.focus({ preventScroll: true }); mouse(event, "mousePressed"); mouse(event, "mouseReleased"); }
          this.touch = undefined;
        } else mouse(event, "mouseReleased");
      };
      this.canvas.onpointercancel = () => { this.touch = undefined; };
      this.canvas.onpointermove = event => {
        if (event.pointerType !== "touch") { mouse(event, "mouseMoved"); return; }
        if (!this.touch) return;
        const deltaX = this.touch.x - event.clientX, deltaY = this.touch.y - event.clientY;
        if (!this.touch.moved && Math.hypot(deltaX, deltaY) < 5) return;
        this.touch = { x: event.clientX, y: event.clientY, moved: true };
        const rect = this.canvas.getBoundingClientRect();
        this.send({ type: "mouse", event: "mouseWheel", x: event.clientX - rect.left, y: event.clientY - rect.top, deltaX, deltaY });
      };
      this.canvas.addEventListener("wheel", event => mouse(event, "mouseWheel"), { passive: false });
      this.canvas.oncontextmenu = event => event.preventDefault();
      for (const type of ["keydown", "keyup"] as const) this.input.addEventListener(type, event => {
        if (event.isComposing || event.keyCode === 229) return;
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") return;
        if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) return;
        event.preventDefault();
        this.send({ type: "key", up: type === "keyup", key: event.key, code: event.code, keyCode: event.keyCode,
          modifiers: (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0) });
      });
      this.input.oncompositionstart = () => { this.composing = true; };
      this.input.oncompositionend = () => { this.composing = false; this.flushText(); };
      this.input.oninput = () => { if (!this.composing) this.flushText(); };
    }
    private flushText() { if (this.input.value) this.send({ type: "text", text: this.input.value }); this.input.value = ""; }
    private send(value: unknown) { if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(value)); }
    connectedCallback() { queueMicrotask(() => { if (this.isConnected) void this.connect(); }); }
    disconnectedCallback() {
      queueMicrotask(() => {
        if (this.isConnected) return;
        clearTimeout(this.reconnect); clearInterval(this.viewTimer);
        this.socket?.close();
        if (this.token) void invoke("codex-web:close-browser", this.token).catch(() => {});
        this.token = undefined;
      });
    }
    focus(options?: FocusOptions) { this.input.focus(options); }
    private async connect() {
      if (this.attaching || !this.isConnected) return;
      this.attaching = true;
      try {
        if (!this.token) {
          const result = await invoke("codex-web:attach-browser", Object.fromEntries([...this.attributes].map(a => [a.name, a.value]))) as { token: string };
          this.token = result.token;
        }
        if (!this.isConnected) { await invoke("codex-web:close-browser", this.token); this.token = undefined; return; }
        const url = new URL("/__backend/browser-stream", location.href);
        url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
        url.searchParams.set("token", this.token);
        const socket = this.socket = new WebSocket(url);
        socket.binaryType = "blob";
        socket.onmessage = async event => {
          if (event.data instanceof Blob) {
            try {
              const bitmap = await createImageBitmap(event.data);
              this.canvas.width = bitmap.width; this.canvas.height = bitmap.height;
              this.canvas.getContext("2d")!.drawImage(bitmap, 0, 0); bitmap.close();
              this.status.textContent = "";
            } finally { this.send({ type: "ack" }); }
          } else {
            const message = JSON.parse(event.data);
            if (message.type === "ready") { this.viewState = ""; this.syncView(); this.viewTimer = window.setInterval(() => this.syncView(), 250); }
            if (message.type === "error") this.status.textContent = "浏览器显示失败：" + message.message;
          }
        };
        socket.onclose = () => {
          clearInterval(this.viewTimer);
          if (this.isConnected) { this.status.textContent = "浏览器连接已断开，正在重连…"; this.reconnect = window.setTimeout(() => this.connect(), 1500); }
        };
      } catch (error) { this.status.textContent = "浏览器无法启动：" + String(error); }
      finally { this.attaching = false; }
    }
    private syncView() {
      const rect = this.getBoundingClientRect();
      const visible = !document.hidden && this.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && rect.width > 0 && rect.height > 0;
      const value = JSON.stringify({ type: "view", visible, width: Math.round(rect.width), height: Math.round(rect.height) });
      if (value !== this.viewState) { this.viewState = value; this.socket?.send(value); }
    }
  });
}
