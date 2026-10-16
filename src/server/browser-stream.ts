import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { BrowserGuest } from "./browser-guest";
import { ServerMonitoring, errorFields, identity, requestFields } from "./observability";

const guests = new Map<string, BrowserGuest>();
let instanceId = 0;
let monitoring: ServerMonitoring | undefined;

export function installBrowserGuestIpc(ipcMain: any): void {
  ipcMain.handle("codex-web:attach-browser", async (event: any, attributes: Record<string, string>) => {
    const owner = event.sender;
    if (!attributes || typeof attributes.partition !== "string" ||
      !attributes["data-browser-sidebar-browser-tab-id"] ||
      !attributes["data-browser-sidebar-conversation-id"])
      throw new Error("Missing browser host identity");
    if ([...guests.values()].filter(guest => guest.hostWebContents === owner).length >= 12)
      throw new Error("Close a browser tab before opening another");
    const params = { ...attributes, instanceId: ++instanceId };
    const preferences: any = {};
    const attachEvent = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    owner.emit("will-attach-webview", attachEvent, preferences, params);
    if (attachEvent.defaultPrevented || !preferences.session)
      throw new Error("Browser host attachment was rejected");
    const guest = await BrowserGuest.create(owner, params.instanceId, preferences.session);
    if (owner.isDestroyed()) { guest.destroy(); throw new Error("Browser owner closed"); }
    const token = randomBytes(32).toString("base64url");
    guests.set(token, guest);
    monitoring?.event("guest.create", { guest: identity(token) });
    const dispose = () => guest.destroy();
    owner.once("destroyed", dispose);
    guest.once("destroyed", () => { monitoring?.event("guest.destroy", { guest: identity(token) }); guests.delete(token); owner.removeListener("destroyed", dispose); });
    try { owner.emit("did-attach-webview", {}, guest); }
    catch (error) { guest.destroy(); throw error; }
    return { token, id: guest.id };
  });
  ipcMain.handle("codex-web:close-browser", (event: any, token: string) => {
    const guest = guests.get(token);
    if (!guest || guest.hostWebContents !== event.sender) throw new Error("Browser owner mismatch");
    guest.destroy();
  });
}

export function createBrowserStreamUpgrade(observer?: ServerMonitoring): (request: IncomingMessage, socket: Duplex, head: Buffer) => void {
  monitoring = observer;
  const server = new WebSocketServer({ noServer: true, maxPayload: 65536, perMessageDeflate: false });
  server.on("connection", async (socket: WebSocket, request: IncomingMessage) => {
    const trace = observer?.connection("stream", socket, request);
    socket.on("error", () => socket.terminate());
    const token = new URL(request.url!, "http://localhost").searchParams.get("token")!;
    const guest = guests.get(token);
    if (!guest || guest.isDestroyed()) { trace?.event("guest_missing"); socket.close(1008); return; }
    let visible = false, stopped = false, frameSession: number | undefined;
    let pendingFrame: { sessionId: number; data: string } | undefined;
    let sentFrames = 0, coalescedFrames = 0;
    const capture = await guest.context.newCDPSession(guest.page).catch(error => { trace?.event("cdp_error", errorFields(error)); return null; });
    if (!capture) { socket.close(1011); return; }
    trace?.event("cdp_attached");
    if (socket.readyState !== WebSocket.OPEN) { await capture.detach(); return; }
    let work = Promise.resolve();
    const send = (value: unknown) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
    };
    capture.on("Page.screencastFrame", frame => {
      if (!stopped && visible && frameSession === undefined && socket.readyState === WebSocket.OPEN && socket.bufferedAmount < 256 * 1024) {
        frameSession = frame.sessionId;
        sentFrames++;
        socket.send(Buffer.from(frame.data, "base64"));
      } else if (!stopped && visible) {
        coalescedFrames++;
        if (pendingFrame) void capture.send("Page.screencastFrameAck", { sessionId: pendingFrame.sessionId }).catch(() => {});
        pendingFrame = frame;
      } else void capture.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
    });
    const close = () => { trace?.event("guest_destroyed"); stopped = true; socket.close(); };
    guest.once("destroyed", close);
    const sample = setInterval(() => trace?.event("frames", { sentFrames, coalescedFrames, bufferedBytes: socket.bufferedAmount, visible }), 60_000);
    sample.unref();
    socket.on("close", () => { clearInterval(sample); trace?.event("frames", { sentFrames, coalescedFrames, bufferedBytes: socket.bufferedAmount, visible }); stopped = true; void capture.detach().then(() => trace?.event("cdp_detached"), error => trace?.event("cdp_error", errorFields(error))); guest.removeListener("destroyed", close); });
    socket.on("message", raw => {
      let message: any;
      try { message = JSON.parse(String(raw)); if (!message || typeof message !== "object") throw Error("Invalid stream frame"); } catch { trace?.event("invalid_frame"); socket.close(1008); return; }
      if (message.type === "ack") {
        if (frameSession !== undefined) void capture.send("Page.screencastFrameAck", { sessionId: frameSession }).catch(() => {});
        frameSession = undefined;
        if (pendingFrame && visible && socket.readyState === WebSocket.OPEN) {
          frameSession = pendingFrame.sessionId;
          sentFrames++;
          socket.send(Buffer.from(pendingFrame.data, "base64"));
          pendingFrame = undefined;
        }
        return;
      }
      work = work.then(async () => {
        if (stopped) return;
        switch (message.type) {
          case "view": {
            const wasVisible = visible;
            visible = message.visible === true;
            const width = Math.round(Number(message.width)), height = Math.round(Number(message.height));
            if (visible && width >= 1 && height >= 1 && width <= 2560 && height <= 2560) {
              const old = guest.page.viewportSize();
              if (old?.width !== width || old?.height !== height) await guest.page.setViewportSize({ width, height });
            }
            if (visible !== wasVisible) {
              trace?.event("visibility", { visible });
              if (visible) await capture.send("Page.startScreencast", { format: "jpeg", quality: 80, maxWidth: 2560, maxHeight: 2560 });
              else await capture.send("Page.stopScreencast");
            }
            break;
          }
          case "mouse": {
            if (!visible || !["mouseMoved", "mousePressed", "mouseReleased", "mouseWheel"].includes(message.event)) return;
            await guest.cdp.send("Input.dispatchMouseEvent", {
              type: message.event, x: Number(message.x), y: Number(message.y),
              button: ["left", "right", "middle"].includes(message.button) ? message.button : "none",
              buttons: message.buttons | 0, clickCount: message.clickCount | 0,
              ...(message.event === "mouseWheel" ? { deltaX: Number(message.deltaX), deltaY: Number(message.deltaY) } : {}),
            });
            break;
          }
          case "key":
            if (visible) await guest.cdp.send("Input.dispatchKeyEvent", {
              type: message.up ? "keyUp" : "keyDown", key: String(message.key), code: String(message.code),
              windowsVirtualKeyCode: message.keyCode | 0, modifiers: message.modifiers | 0,
              ...(message.text ? { text: String(message.text) } : {}),
            });
            break;
          case "text":
            if (visible && typeof message.text === "string") await guest.cdp.send("Input.insertText", { text: message.text });
            break;
        }
      }).catch(error => { trace?.event("handler_error", errorFields(error)); send({ type: "error", message: String(error) }); });
    });
    send({ type: "ready" });
  });
  return (request, socket, head) => {
    const url = new URL(request.url!, "http://localhost");
    const guest = guests.get(url.searchParams.get("token") ?? "");
    if (!guest || guest.isDestroyed()) { observer?.event("stream.rejected", { ...requestFields(request), reason: "guest_missing" }); socket.destroy(); return; }
    server.handleUpgrade(request, socket, head, ws => server.emit("connection", ws, request));
  };
}
