import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
import { z } from "zod";

type Json = Record<string, any>;
type Connection = { webview: HTMLIFrameElement; signal: AbortSignal; sourceUrl: string; hostApiHandlers: Json };

// Only the bundled Code Review's content-addressed scripts/styles are shared.
// Tool results, PR contents and unversioned resources always go through the host.
const codeReviewAssets = new Map<string, Promise<Json>>();
async function readResource(sourceUrl: string, host: Json, params: Json) {
  const address = /^ui:\/\/pull-requests\/app-([a-f0-9]{64})\.(?:js|css)$/.exec(params.uri);
  if (!address) return host.callMcp({ method: "resources/read", params });
  const key = JSON.stringify([sourceUrl, params.uri]);
  let pending = codeReviewAssets.get(key);
  if (!pending) {
    pending = (async () => {
      const response = await host.callMcp({ method: "resources/read", params });
      const contents = response.contents;
      if (contents?.length !== 1 || typeof contents[0].text !== "string") throw new Error("Code Review static resource is missing");
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(contents[0].text));
      const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
      if (hash !== address[1]) throw new Error("Code Review static resource hash differs");
      return response;
    })();
    codeReviewAssets.set(key, pending);
    pending.catch(() => { if (codeReviewAssets.get(key) === pending) codeReviewAssets.delete(key); });
  }
  return pending;
}

// Opaque frames cannot use browser storage. Keep each app's preferences in its
// own host-owned namespace; the app never receives access to the host store.
function preferenceBootstrap(values: Record<string, string>, token: string) {
  const entries = new Map(Object.entries(values));
  const save = () => parent.postMessage({ type: "mcp-app-preferences", token, values: Object.fromEntries(entries) }, "*");
  const storage = {
    get length() { return entries.size; },
    key(index: number) { return Array.from(entries.keys())[index] ?? null; },
    getItem(key: string) { return entries.get(String(key)) ?? null; },
    setItem(key: string, value: string) { entries.set(String(key), String(value)); save(); },
    removeItem(key: string) { entries.delete(String(key)); save(); },
    clear() { entries.clear(); save(); },
  };
  Object.defineProperty(window, "localStorage", { value: storage });
}

export function connect({ webview, signal, sourceUrl, hostApiHandlers: host }: Connection) {
  let bridge: AppBridge | undefined;
  let documentUrl: string | undefined;
  let preferencesToken: string;
  const storageKey = "codex:web-mcp-app:" + sourceUrl;
  const savePreferences = (event: MessageEvent) => {
    if (event.source === webview.contentWindow && event.data?.type === "mcp-app-preferences" && event.data.token === preferencesToken) {
      localStorage.setItem(storageKey, JSON.stringify(event.data.values));
    }
  };
  window.addEventListener("message", savePreferences);
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    signal.removeEventListener("abort", stop);
    window.removeEventListener("message", savePreferences);
    void bridge?.close();
    webview.removeAttribute("src");
    if (documentUrl) void fetch(documentUrl, { method: "DELETE", credentials: "same-origin" });
  };
  signal.addEventListener("abort", stop, { once: true });
  const context = (value: Json) => { if (!stopped) bridge?.setHostContext(value); };
  return {
    async *runWidgetCode(args: Json) {
      signal.throwIfAborted();
      webview.setAttribute("sandbox", "allow-scripts allow-forms");
      webview.referrerPolicy = "no-referrer";
      const resources = (args.csp?.resourceDomains ?? []).join(" ");
      const connections = (args.csp?.connectDomains ?? []).join(" ");
      const policy = ["default-src 'none'", `script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' ${resources}`, `style-src 'unsafe-inline' ${resources}`, `img-src data: blob: ${resources}`, `font-src data: ${resources}`, `media-src ${resources}`, `connect-src ${connections}`, "frame-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'"].join("; ");
      const ready = Promise.withResolvers<void>();
      bridge = new AppBridge(null, args.mcpApps.hostInfo, args.mcpApps.hostCapabilities, { hostContext: args.mcpApps.hostContext });
      const connection = bridge;
      bridge.onclose = () => { if (bridge === connection) bridge = undefined; };
      bridge.oncalltool = params => host.callMcp({ method: "tools/call", params });
      bridge.onreadresource = params => readResource(sourceUrl, host, params);
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
      bridge.setRequestHandler("ui/openai/first-party-plugin-bridge", {
        params: z.object({ message: z.string() }),
      }, params => host.callMcp({ method: "ui/openai/first-party-plugin-bridge", params }));
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
      preferencesToken = crypto.randomUUID();
      const values = JSON.parse(localStorage.getItem(storageKey) ?? "{}");
      const bootstrap = `(${preferenceBootstrap.toString()})(${JSON.stringify(values).replaceAll("<", "\\u003c")},${JSON.stringify(preferencesToken)});`;
      const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="${policy.replaceAll('"', '&quot;')}"><script>${bootstrap}</script></head><body>${args.html}</body></html>`;
      const response = await fetch("/__backend/mcp-app-documents", { method: "POST", credentials: "same-origin", signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ html }) });
      if (!response.ok) throw new Error("MCP app document could not be created");
      if (documentUrl) void fetch(documentUrl, { method: "DELETE", credentials: "same-origin" });
      documentUrl = (await response.json()).url;
      signal.throwIfAborted();
      const timeout = setTimeout(() => ready.reject(new Error("MCP app did not initialize")), 15_000);
      webview.src = documentUrl!;
      try { await ready.promise; } finally { clearTimeout(timeout); signal.removeEventListener("abort", aborted); }
      signal.throwIfAborted();
      yield { type: "environment_status", status: 2 };
    },
    async notifyMcpAppsHostContext({ hostContext }: Json) { context(hostContext); },
    async notifyMcpAppsToolInput(args: Json) { await bridge?.sendToolInput(args); },
    async notifyMcpAppsToolResult(args: Json) { await bridge?.sendToolResult(args); },
    async notifyMcpAppsToolCancelled(args: Json) { await bridge?.sendToolCancelled(args); },
    async notifyMcpAppsMcpNotification(notification: Json) { await bridge?.notification(notification as any); },
    async setTheme({ theme }: Json) { context({ theme }); },
    async setSafeArea() {},
    async setAdditionalGlobals() {},
    async setWidgetData() {},
    async setWidgetView() {},
    async requestMcpAppsResourceTeardown() { stop(); },
  };
}
