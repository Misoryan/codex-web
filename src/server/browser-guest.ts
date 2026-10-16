import { EventEmitter } from "node:events";
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from "playwright-core";

let browserPromise: Promise<Browser> | undefined;
let pendingCreates = 0;
let nextId = 1000000000;
export const browserGuests = new Map<number, BrowserGuest>();

async function browser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = chromium.launch({ channel: "chrome", headless: true });
    browserPromise.catch(() => { browserPromise = undefined; });
    browserPromise.then(value => value.on("disconnected", () => { browserPromise = undefined; }), () => {});
  }
  return browserPromise;
}

// Electron's browser manager owns navigation and task association. This guest
// supplies the Chromium page used by both that manager and the streamed view.
export class BrowserGuest extends EventEmitter {
  readonly id = nextId++;
  readonly mainFrame: { url: string; executeJavaScript: (script: string) => Promise<unknown> };
  readonly debugger: EventEmitter & {
    attach: () => void; detach: () => void; isAttached: () => boolean;
    sendCommand: (method: string, params?: any, sessionId?: string) => Promise<any>;
  };
  readonly navigationHistory = {
    getActiveIndex: () => this.historyIndex,
    canGoBack: () => this.canGoBack(),
    canGoForward: () => this.canGoForward(),
    getAllEntries: () => this.history,
    goBack: () => this.goBack(),
    goForward: () => this.goForward(),
    goToIndex: (index: number) => this.navigateHistory(index),
  };
  private history: { id: number; url: string; title: string }[] = [];
  private historyIndex = -1;
  private loading = false;
  private title = "";
  private agentActive = false;
  private contentInsets = { top: 0 };
  private destroyed = false;
  private zoom = 1;
  private throttled = true;
  private attached = false;
  private openHandler: ((details: any) => any) | undefined;
  private constructor(
    readonly hostWebContents: any,
    readonly viewInstanceId: number,
    readonly session: any,
    readonly context: BrowserContext,
    readonly page: Page,
    readonly cdp: CDPSession,
  ) {
    super();
    this.mainFrame = { url: "", executeJavaScript: script => this.executeJavaScript(script) };
    this.debugger = Object.assign(new EventEmitter(), {
      attach: () => { this.attached = true; },
      detach: () => { this.attached = false; },
      isAttached: () => this.attached,
      sendCommand: async (method: string, params: any = {}, sessionId?: string) => {
        if (sessionId) throw new Error("Child CDP sessions are not supported by the Web browser guest");
        return (this.cdp.send as any)(method, params);
      },
    });
    for (const event of [
      "Page.frameNavigated", "Page.frameAttached", "Page.frameDetached", "Page.loadEventFired",
      "Page.domContentEventFired", "Page.lifecycleEvent", "Page.javascriptDialogOpening",
      "Page.javascriptDialogClosed", "Runtime.executionContextCreated", "Runtime.executionContextDestroyed",
      "Runtime.executionContextsCleared", "Runtime.consoleAPICalled", "Runtime.exceptionThrown",
      "Network.requestWillBeSent", "Network.responseReceived", "Network.loadingFinished",
      "Network.loadingFailed", "Target.attachedToTarget", "Target.detachedFromTarget",
      "DOM.documentUpdated", "Log.entryAdded",
    ]) (cdp.on as any)(event, (params: unknown) => this.debugger.emit("message", {}, event, params));
    page.on("framenavigated", frame => {
      if (frame !== page.mainFrame()) return;
      this.mainFrame.url = frame.url();
      this.emit("did-navigate", {}, frame.url(), 200, "OK");
      void this.refreshHistory();
    });
    page.on("domcontentloaded", () => this.emit("dom-ready"));
    page.on("load", () => {
      this.loading = false;
      void this.refreshHistory().then(() => {
        this.emit("did-finish-load");
        this.emit("did-stop-loading");
      });
    });
    page.on("close", () => this.destroy());
    page.on("crash", () => this.emit("render-process-gone", {}, { reason: "crashed" }));
    page.on("popup", popup => {
      this.openHandler?.({ url: popup.url(), disposition: "new-window", referrer: { url: page.url() } });
      void popup.close();
    });
    browserGuests.set(this.id, this);
  }
  static async create(owner: any, instanceId: number, session: any): Promise<BrowserGuest> {
    pendingCreates++;
    try {
      const context = await (await browser()).newContext({ viewport: { width: 1024, height: 768 } });
      try {
        const page = await context.newPage();
        return new BrowserGuest(owner, instanceId, session, context, page, await context.newCDPSession(page));
      } catch (error) { await context.close(); throw error; }
    } finally { pendingCreates--; }
  }
  private async refreshHistory(): Promise<void> {
    if (this.destroyed) return;
    try {
      const history = await this.cdp.send("Page.getNavigationHistory");
      this.history = history.entries;
      this.historyIndex = history.currentIndex;
      this.title = await this.page.title();
      this.emit("page-title-updated", {}, this.title);
    } catch { /* Navigation can replace the document while its title is read. */ }
  }
  getURL(): string { return this.mainFrame.url; }
  getTitle(): string { return this.title; }
  setAgentActive(active: boolean): void {
    if (this.agentActive === active) return;
    this.agentActive = active;
    this.emit("agent-active-changed", active);
  }
  setContentInsets(insets: { top: number }): void {
    const top = Math.max(0, Math.round(insets.top));
    if (this.contentInsets.top === top) return;
    this.contentInsets = { top };
    this.emit("content-insets-changed", this.contentInsets);
  }
  getType(): string { return "webview"; }
  isDestroyed(): boolean { return this.destroyed; }
  isLoading(): boolean { return this.loading; }
  isLoadingMainFrame(): boolean { return this.loading; }
  isCurrentlyAudible(): boolean { return false; }
  isAudioMuted(): boolean { return true; }
  isCapturingUserMedia(): boolean { return false; }
  isCapturingCamera(): boolean { return false; }
  isCapturingMicrophone(): boolean { return false; }
  isBeingCaptured(): boolean { return false; }
  canGoBack(): boolean { return this.historyIndex > 0; }
  canGoForward(): boolean { return this.historyIndex + 1 < this.history.length; }
  async loadURL(url: string): Promise<void> {
    if (!/^(https?:|about:blank$)/.test(url)) throw new Error("Browser URL must use HTTP or HTTPS");
    this.loading = true;
    this.emit("did-start-navigation", {}, url, false, true);
    this.emit("did-start-loading");
    try { await this.page.goto(url, { waitUntil: "domcontentloaded" }); }
    catch (error) {
      this.loading = false;
      this.emit("did-fail-load", {}, -2, String(error), url, true);
      this.emit("did-stop-loading");
      throw error;
    }
  }
  async executeJavaScript(script: string): Promise<unknown> { return this.page.evaluate(script); }
  async navigateHistory(index: number): Promise<void> {
    const entry = this.history[index];
    if (entry) await this.cdp.send("Page.navigateToHistoryEntry", { entryId: entry.id });
  }
  goBack(): void { void this.navigateHistory(this.historyIndex - 1); }
  goForward(): void { void this.navigateHistory(this.historyIndex + 1); }
  reload(): void { void this.page.reload(); }
  reloadIgnoringCache(): void { void this.cdp.send("Page.reload", { ignoreCache: true }); }
  stop(): void { void this.cdp.send("Page.stopLoading"); }
  focus(): void { this.emit("focus"); }
  setZoomFactor(value: number): void { this.zoom = value; }
  getZoomFactor(): number { return this.zoom; }
  setZoomLevel(value: number): void { this.zoom = 1.2 ** value; }
  getZoomLevel(): number { return Math.log(this.zoom) / Math.log(1.2); }
  setBackgroundThrottling(value: boolean): void { this.throttled = value; }
  getBackgroundThrottling(): boolean { return this.throttled; }
  setWindowOpenHandler(handler: (details: any) => any): void { this.openHandler = handler; }
  send(channel: string, message: unknown): void {
    // Browser annotation preload is Electron-specific. Do not inject application
    // IPC or Node access into pages loaded from the Internet.
    this.emit("web-preload-message", channel, message);
  }
  close(): void { this.destroy(); }
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    browserGuests.delete(this.id);
    this.emit("destroyed");
    void this.context.close().finally(async () => {
      if (!browserGuests.size && !pendingCreates && browserPromise) {
        const pending = browserPromise;
        browserPromise = undefined;
        await (await pending).close();
      }
    }).catch(error => console.warn("Browser process cleanup failed", String(error)));
  }
}
