import hostBridge from "./visualization-host-bridge.js?raw";

type Globals = Record<string, unknown>;
type EnvironmentError = { name: string; message: string; stack?: string };
type FollowUp = { prompt: string; context?: unknown; title?: string };
type Handlers = {
  notifyIntrinsicHeight(height: number): unknown;
  notifyEnvironmentError(error: EnvironmentError): unknown;
  callTool(name: string, args: unknown): unknown;
  requestDisplayMode(args: unknown): unknown;
  openExternal(args: { href: string }): unknown;
  sendFollowUpMessage(args: FollowUp): unknown;
};
type RenderArgs = {
  html: string;
  theme: string;
  csp: { resourceDomains: string[]; connectDomains: string[] };
};
type HostContext = Globals & { containerDimensions: { maxWidth: number; maxHeight: number } };
type Connection = {
  hostApiHandlers: Handlers;
  sandboxId: string;
  signal: AbortSignal;
  sourceUrl: string;
  webview: HTMLIFrameElement;
};

function scriptJson(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

export function connect({ hostApiHandlers, sandboxId, signal, sourceUrl, webview }: Connection) {
  signal.throwIfAborted();
  webview.setAttribute("sandbox", "allow-scripts");
  webview.referrerPolicy = "no-referrer";
  const storageKey = "codex:web-visualization:" + sourceUrl + ":" + sandboxId;
  let port: MessagePort | null = null;
  let widgetState: unknown = null;
  try {
    widgetState = JSON.parse(localStorage.getItem(storageKey) ?? "null");
  } catch {
    widgetState = null;
  }
  const update = (globals: unknown) => port?.postMessage({ type: "host-update", globals });
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    signal.removeEventListener("abort", stop);
    port?.close();
    port = null;
    webview.removeAttribute("srcdoc");
  };
  signal.addEventListener("abort", stop, { once: true });
  return {
    async *runWidgetCode(args: RenderArgs) {
      signal.throwIfAborted();
      port?.close();
      const channel = new MessageChannel();
      port = channel.port1;
      const resources = args.csp.resourceDomains.join(" ");
      const connections = args.csp.connectDomains.join(" ");
      const policy = [
        "default-src 'none'",
        "script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' " + resources,
        "style-src 'unsafe-inline' " + resources,
        "img-src " + resources,
        "font-src " + resources,
        "media-src " + resources,
        "worker-src blob:",
        "connect-src " + connections,
        "frame-src 'none'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
      ].join("; ").replaceAll('"', "&quot;");
      let loaded = false;
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => finish(new Error("Visualization frame did not initialize")), 15_000);
        const aborted = () => finish(signal.reason ?? new DOMException("Aborted", "AbortError"));
        const finish = (error?: unknown) => {
          clearTimeout(timeout);
          signal.removeEventListener("abort", aborted);
          window.removeEventListener("message", initialize);
          error == null ? resolve() : reject(error);
        };
        const rendered = () => {
          if (loaded) return;
          loaded = true;
          finish();
        };
        const initialize = (event: MessageEvent) => {
          if (event.source !== webview.contentWindow || event.data?.type !== "codex-visualization-ready") return;
          window.removeEventListener("message", initialize);
          webview.contentWindow?.postMessage({ type: "codex-visualization-initialize" }, "*", [channel.port2]);
        };
        channel.port1.onmessage = async ({ data }) => {
          if (signal.aborted || data == null || typeof data !== "object") return;
          if (data.type === "height" && Number.isFinite(data.height) && data.height > 0 && data.height <= 100_000) {
            hostApiHandlers.notifyIntrinsicHeight(data.height);
            rendered();
          } else if (data.type === "environment-error") {
            hostApiHandlers.notifyEnvironmentError(data.error);
            if (!loaded) finish(new Error(data.error.message));
          } else if (data.type === "host-call" && Number.isSafeInteger(data.id)) {
            try {
              let result: unknown;
              if (data.method === "callTool") {
                result = await hostApiHandlers.callTool(data.name, data.args);
                if (data.name === "__codex_inline_visualization_height__" && Number.isFinite(data.args) && data.args > 0 && data.args <= 100_000) rendered();
              }
              else if (data.method === "requestDisplayMode") result = await hostApiHandlers.requestDisplayMode(data.args);
              else throw new Error("Unsupported visualization method");
              channel.port1.postMessage({ type: "host-result", id: data.id, result });
            } catch (error) {
              channel.port1.postMessage({ type: "host-result", id: data.id, error: String(error) });
            }
          } else if (data.type === "widget-state-write" && Number.isSafeInteger(data.id)) {
            let ok = false;
            try {
              if (typeof data.state !== "string" || new TextEncoder().encode(data.state).length > 16 * 1024) throw new Error("Invalid widget state");
              const next = JSON.parse(data.state);
              if (next == null || typeof next !== "object" || Array.isArray(next) || next.imageIds?.length) throw new Error("Invalid widget state");
              localStorage.setItem(storageKey, data.state);
              widgetState = next;
              ok = true;
            } catch {
              ok = false;
            }
            channel.port1.postMessage({ type: "widget-state-result", id: data.id, ok });
          } else if (data.type === "open-external" && typeof data.href === "string" && navigator.userActivation.isActive) {
            const url = new URL(data.href, sourceUrl);
            if (url.protocol === "https:") await hostApiHandlers.openExternal({ href: url.href });
          } else if (data.type === "follow-up" && typeof data.prompt === "string" && navigator.userActivation.isActive) {
            await hostApiHandlers.sendFollowUpMessage({ context: data.context, prompt: data.prompt, title: data.title });
          } else if (data.type === "scroll-to" && Number.isFinite(data.top) && data.top >= 0 && navigator.userActivation.isActive) {
            window.scrollTo({ top: window.scrollY + webview.getBoundingClientRect().top + data.top });
          }
        };
        channel.port1.start();
        signal.addEventListener("abort", aborted, { once: true });
        window.addEventListener("message", initialize);
        const globals = { widgetState, statePersistence: "local", visualizationTheme: args.theme };
        webview.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="${policy}"></head><body><script type="application/json" id="codex-visualization-widget-state">${scriptJson(globals)}</script><script>${hostBridge.replaceAll("</script", "<\\/script")}</script>${args.html}</body></html>`;
      });
      signal.throwIfAborted();
      yield { type: "environment_status", status: 2 };
    },
    async setTheme({ theme }: { theme: string }) { update({ theme, visualizationTheme: theme }); },
    async setAdditionalGlobals({ additionalGlobals }: { additionalGlobals: Globals }) { update(additionalGlobals); },
    async setSafeArea({ safeArea }: { safeArea: unknown }) { update({ safeArea }); },
    async notifyMcpAppsHostContext({ hostContext }: { hostContext: HostContext }) { update({ ...hostContext, maxWidth: hostContext.containerDimensions.maxWidth, maxHeight: hostContext.containerDimensions.maxHeight }); },
    async setWidgetData(globals: unknown) { update(globals); },
    async setWidgetView(globals: unknown) { update(globals); },
    async requestMcpAppsResourceTeardown() { stop(); },
  };
}
