import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";

type Json = Record<string, any>;
type Connection = { webview: HTMLIFrameElement; signal: AbortSignal; hostApiHandlers: Json };

export function connect({ webview, signal, hostApiHandlers: host }: Connection) {
  let bridge: AppBridge | undefined;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    signal.removeEventListener("abort", stop);
    void bridge?.close();
    webview.removeAttribute("srcdoc");
  };
  signal.addEventListener("abort", stop, { once: true });
  const context = (value: Json) => bridge?.setHostContext(value);
  return {
    async *runWidgetCode(args: Json) {
      signal.throwIfAborted();
      webview.setAttribute("sandbox", "allow-scripts");
      webview.referrerPolicy = "no-referrer";
      const resources = (args.csp?.resourceDomains ?? []).join(" ");
      const connections = (args.csp?.connectDomains ?? []).join(" ");
      const policy = ["default-src 'none'", `script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' ${resources}`, `style-src 'unsafe-inline' ${resources}`, `img-src data: blob: ${resources}`, `font-src data: ${resources}`, `media-src ${resources}`, `connect-src ${connections}`, "frame-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'"].join("; ");
      const ready = Promise.withResolvers<void>();
      bridge = new AppBridge(null, args.mcpApps.hostInfo, args.mcpApps.hostCapabilities, { hostContext: args.mcpApps.hostContext });
      bridge.oncalltool = params => host.callMcp({ method: "tools/call", params });
      bridge.onreadresource = params => host.callMcp({ method: "resources/read", params });
      bridge.onlisttools = params => host.callMcp({ method: "tools/list", params });
      bridge.onlistresources = params => host.callMcp({ method: "resources/list", params });
      bridge.onlistresourcetemplates = params => host.callMcp({ method: "resources/templates/list", params });
      bridge.onopenlink = async ({ url }) => {
        const target = new URL(url);
        if (target.protocol === "codex:" && target.hostname === "threads" && /^\/[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(target.pathname) && !target.search && !target.hash && !target.username && !target.password && !target.port) {
          window.dispatchEvent(new MessageEvent("message", { data: { type: "navigate-to-route", path: "/local" + target.pathname } }));
        } else await host.openExternal({ href: url });
        return {};
      };
      bridge.onrequestdisplaymode = async ({ mode }) => { await host.requestDisplayMode({ mode }); return { mode }; };
      bridge.onmessage = params => host.callMcp({ method: "ui/message", params });
      bridge.onupdatemodelcontext = params => host.callMcp({ method: "ui/update-model-context", params });
      bridge.addEventListener("sizechange", ({ height, width }) => {
        if (Number.isFinite(height) && height! > 0 && height! <= 100_000) host.notifyIntrinsicHeight(height);
        if (Number.isFinite(width) && width! > 0 && width! <= 100_000) host.notifyIntrinsicWidth(width);
      });
      bridge.addEventListener("initialized", async () => {
        try {
          await host.initializeMcpApp({ availableDisplayModes: args.mcpApps.hostContext.availableDisplayModes });
          await bridge!.sendToolInput({ arguments: args.toolInput ?? {} });
          ready.resolve();
        } catch (error) { ready.reject(error); }
      });
      bridge.onerror = error => { ready.reject(error); host.notifyEnvironmentError({ name: error.name, message: error.message }); };
      await bridge.connect(new PostMessageTransport(webview.contentWindow!, webview.contentWindow!));
      const aborted = () => ready.reject(signal.reason);
      signal.addEventListener("abort", aborted, { once: true });
      const timeout = setTimeout(() => ready.reject(new Error("MCP app did not initialize")), 15_000);
      webview.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="${policy.replaceAll('"', '&quot;')}"></head><body>${args.html}</body></html>`;
      try { await ready.promise; } finally { clearTimeout(timeout); signal.removeEventListener("abort", aborted); }
      signal.throwIfAborted();
      yield { type: "environment_status", status: 2 };
    },
    async notifyMcpAppsHostContext({ hostContext }: Json) { context(hostContext); },
    async notifyMcpAppsToolInput(args: Json) { await bridge?.sendToolInput(args); },
    async notifyMcpAppsToolResult(args: Json) { await bridge?.sendToolResult(args); },
    async notifyMcpAppsToolCancelled(args: Json) { await bridge?.sendToolCancelled(args); },
    async setTheme({ theme }: Json) { context({ theme }); },
    async setSafeArea() {},
    async setAdditionalGlobals() {},
    async setWidgetData() {},
    async setWidgetView() {},
    async requestMcpAppsResourceTeardown() { stop(); },
  };
}
