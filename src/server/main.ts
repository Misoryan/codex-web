#!/usr/bin/env node

declare global {
  var __CODEX_SHIM_VALUES__: {
    version: string;
  };
}

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs as parseCliArgs } from "node:util";
import { WebSocket, WebSocketServer } from "ws";
import Fastify from "fastify";
import fastifyMultipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { installModuleAliasHook } from "./module";
import { hideBackgroundProcessWindows } from "./background-processes";
import { createBrowserStreamUpgrade } from "./browser-stream";
import { synchronizeGlobalState } from "./global-state-sync";
import { RendererSessions } from "./renderer-sessions";
import { StatsigCache } from "./statsig-cache";
import { PersistedStateEncoder } from "../shared/persisted-state-wire";
import { registerSub2ApiUsage } from "./sub2api-usage";
import { registerLocalProfile } from "./local-profile";
import { registerFeatureConfig } from "./feature-config";
import { registerMcpAppDocuments } from "./mcp-app-documents";
import { MonitoringDestination, ServerMonitoring, installHttpMonitoring, requestFields, errorFields, identity } from "./observability";
import { installProcessLogging } from "./process-logging";

let processLogging: ReturnType<typeof installProcessLogging> | undefined;

type ServerOptions = {
  host: string;
  port: number;
};

type RendererToMainMessage =
  | {
      type: "ipc-renderer-invoke";
      requestId: string;
      channel: string;
      args: unknown[];
      sourceUrl: string;
    }
  | {
      type: "ipc-renderer-send";
      channel: string;
      args: unknown[];
      sourceUrl: string;
    }
  | {
      type: "ipc-renderer-post-message";
      channel: string;
      message: unknown;
      portIds: string[];
      sourceUrl?: string;
    }
  | {
      type: "message-port-message";
      portId: string;
      data: unknown;
    }
  | {
      type: "message-port-close";
      portId: string;
    }
  | {
      type: "workspace-directory-entries-request";
      requestId: string;
      directoryPath: string | null;
      directoriesOnly: boolean;
    };

type MainToRendererMessage =
  | {
      type: "ipc-main-event";
      channel: string;
      args: unknown[];
    }
  | {
      type: "ipc-renderer-invoke-result";
      requestId: string;
      ok: true;
      result: unknown;
    }
  | {
      type: "ipc-renderer-invoke-result";
      requestId: string;
      ok: false;
      errorMessage: string;
    }
  | {
      type: "workspace-directory-entries-result";
      requestId: string;
      ok: true;
      result: WorkspaceDirectoryEntries;
    }
  | {
      type: "workspace-directory-entries-result";
      requestId: string;
      ok: false;
      errorMessage: string;
    }
  | {
      type: "message-port-message";
      portId: string;
      data: unknown;
    }
  | {
      type: "message-port-close";
      portId: string;
    };

type WorkspaceDirectoryEntry = {
  name: string;
  path: string;
  type: "directory" | "file";
};

type WorkspaceDirectoryEntries = {
  directoryPath: string;
  parentPath: string | null;
  entries: WorkspaceDirectoryEntry[];
};

type MessagePortListener = (...args: unknown[]) => void;

type BridgedMessagePort = {
  close: () => void;
  on: (event: string, listener: MessagePortListener) => unknown;
  postMessage: (message: unknown) => void;
  start: () => void;
};

class WebSocketMessagePort implements BridgedMessagePort {
  private closed = false;
  private readonly pendingMessages: unknown[] = [];
  private readonly listeners = new Map<string, Set<MessagePortListener>>();

  constructor(
    private readonly portId: string,
    private readonly sendToRenderer: (message: MainToRendererMessage) => void,
    private readonly onClosed: () => void,
  ) {}

  on(event: string, listener: MessagePortListener): this {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    if (event === "message") {
      for (const data of this.pendingMessages.splice(0)) {
        this.receiveMessage(data);
      }
    }

    return this;
  }

  postMessage(data: unknown): void {
    if (this.closed) {
      return;
    }
    this.sendToRenderer({
      type: "message-port-message",
      portId: this.portId,
      data,
    });
  }

  start(): void {}

  close(): void {
    if (!this.markClosed()) {
      return;
    }
    this.sendToRenderer({
      type: "message-port-close",
      portId: this.portId,
    });
  }

  receiveMessage(data: unknown): void {
    if (this.closed) {
      return;
    }
    const listeners = this.listeners.get("message");
    if (!listeners || listeners.size === 0) {
      this.pendingMessages.push(data);
      return;
    }
    for (const listener of listeners) {
      listener({ data });
    }
  }

  disconnect(): void {
    if (!this.markClosed()) {
      return;
    }
    this.emit("close");
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...args);
    }
  }

  private markClosed(): boolean {
    if (this.closed) {
      return false;
    }
    this.closed = true;
    this.pendingMessages.length = 0;
    this.onClosed();
    return true;
  }
}

function workspaceDirectoryEntryTypeRank(
  entry: WorkspaceDirectoryEntry,
): number {
  return entry.type === "directory" ? 0 : 1;
}

function workspaceDirectoryEntryHiddenRank(
  entry: WorkspaceDirectoryEntry,
): number {
  return entry.name.startsWith(".") ? 1 : 0;
}

function compareWorkspaceDirectoryEntries(
  left: WorkspaceDirectoryEntry,
  right: WorkspaceDirectoryEntry,
): number {
  return (
    workspaceDirectoryEntryTypeRank(left) -
      workspaceDirectoryEntryTypeRank(right) ||
    workspaceDirectoryEntryHiddenRank(left) -
      workspaceDirectoryEntryHiddenRank(right) ||
    left.name.localeCompare(right.name)
  );
}

type RendererWindow = {
  id: number;
  webContents: { id: number };
  destroy: () => void;
};

type IpcMainBridgeState = {
  synchronizeGlobalState?: (store: Parameters<typeof synchronizeGlobalState>[0], write: (state: Map<string, unknown>) => void | Promise<void>) => void;
  onGlobalStateChanged?: (keys: string[]) => void;
  setRendererWindowFactory?: (factory: () => Promise<RendererWindow>) => void;
  sendToRenderer?: (
    webContentsId: number,
    message: MainToRendererMessage,
  ) => void;
  handleRendererInvoke?: (
    channel: string,
    args: unknown[],
    windowId: number,
  ) => Promise<unknown>;
  handleRendererPostMessage?: (
    channel: string,
    message: unknown,
    ports: BridgedMessagePort[],
    windowId: number,
  ) => void;
  handleRendererSend?: (
    channel: string,
    args: unknown[],
    windowId: number,
  ) => void;
};

function printUsage(): void {
  console.log(
    [
      "Usage:",
      "  server [--host <host>] [--port <port>]",
      "",
      "Defaults:",
      "  --host 127.0.0.1",
      "  --port 8214",
      "",
      "Examples:",
      "  yarn server",
      "  yarn server --port 9000",
    ].join("\n"),
  );
}

function parsePort(raw: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`Invalid port: ${raw}`);
  }
  return parsed;
}

function parseServerArgs(args: string[]): ServerOptions {
  const parsed = parseCliArgs({
    args,
    allowPositionals: false,
    options: {
      help: {
        short: "h",
        type: "boolean",
      },
      host: {
        type: "string",
      },
      port: {
        type: "string",
      },
    },
    strict: true,
  });

  if (parsed.values.help) {
    printUsage();
    process.exit(0);
  }

  return {
    host: parsed.values.host ?? "127.0.0.1",
    port: parsed.values.port ? parsePort(parsed.values.port) : 8214,
  };
}

function getIpcMainBridgeState(): IpcMainBridgeState {
  const globals = globalThis as typeof globalThis & {
    __codexElectronIpcBridge?: IpcMainBridgeState;
  };
  if (!globals.__codexElectronIpcBridge) {
    globals.__codexElectronIpcBridge = {};
  }
  return globals.__codexElectronIpcBridge;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

async function getWorkspaceDirectoryEntries({
  directoryPath,
  directoriesOnly,
}: {
  directoryPath: string | null;
  directoriesOnly: boolean;
}): Promise<WorkspaceDirectoryEntries> {
  const requestedPath = directoryPath?.trim() || os.homedir();
  const resolvedPath = path.resolve(requestedPath);
  const stat = await fs.stat(resolvedPath);
  if (!stat.isDirectory()) {
    throw new Error(`Directory not found: ${requestedPath}`);
  }

  const entries = (await fs.readdir(resolvedPath, { withFileTypes: true }))
    .flatMap((entry): WorkspaceDirectoryEntry[] => {
      const type = entry.isDirectory() ? "directory" : "file";
      if (directoriesOnly && type !== "directory") {
        return [];
      }

      return [
        {
          name: entry.name,
          path: path.join(resolvedPath, entry.name),
          type,
        },
      ];
    })
    .sort(compareWorkspaceDirectoryEntries);

  const rootPath = path.parse(resolvedPath).root;
  const parentPath =
    resolvedPath === rootPath ? null : path.dirname(resolvedPath);

  return {
    directoryPath: resolvedPath,
    parentPath,
    entries,
  };
}

function ensureElectronLikeProcessContext(): void {
  process.env.BUILD_FLAVOR = "prod";

  const versions = process.versions as NodeJS.ProcessVersions & {
    electron?: string;
  };
  if (!versions.electron) {
    Object.defineProperty(versions, "electron", {
      value: "41.2.0",
      configurable: true,
      enumerable: true,
      writable: false,
    });
  }

  const processWithElectronFields = process as NodeJS.Process & {
    getSystemVersion?: () => string;
    resourcesPath?: string;
    type?: string;
  };
  const systemVersion =
    process.platform === "darwin"
      ? execFileSync("/usr/bin/sw_vers", ["-productVersion"], {
          encoding: "utf8",
        }).trim()
      : os.release();
  processWithElectronFields.getSystemVersion ??= () => systemVersion;
  processWithElectronFields.resourcesPath ??= path.resolve(
    __dirname,
    "../../scratch/asar",
  );
  processWithElectronFields.type ??= "browser";
}

export async function createBridgeServer(logDirectory = path.resolve(__dirname, "../../runtime/monitoring")) {
  const bridgeState = getIpcMainBridgeState();
  bridgeState.synchronizeGlobalState = (store, write) => {
    synchronizeGlobalState(store, write, keys => bridgeState.onGlobalStateChanged?.(keys));
  };
  const destination = new MonitoringDestination(logDirectory);
  const app = Fastify({
    logger: { stream: destination, base: { pid: process.pid },
      timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
      redact: { paths: ["msg"], censor: "redacted" },
      serializers: { req: () => ({}), res: () => ({}), err: error => ({ type: "Error", message: "redacted", stack: "", ...errorFields(error) }) } },
    disableRequestLogging: true, genReqId: () => randomUUID(),
  });
  const monitoring = new ServerMonitoring(app.log);
  await registerMcpAppDocuments(app);
  installHttpMonitoring(app, monitoring);
  app.addHook("onClose", async () => { monitoring.event("server.stop"); await destination.close(); });
  app.get("/__backend/health", async () => {
    const storage = await fs.statfs(process.cwd());
    return { ok: true, runId: monitoring.runId, droppedLogRecords: destination.droppedRecords,
      consoleDroppedLogRecords: processLogging?.droppedRecords ?? 0,
      availableDiskBytes: storage.bavail * storage.bsize };
  });
  app.post("/__backend/telemetry", {
    bodyLimit: 4096,
    schema: { body: { type: "object", additionalProperties: false, required: ["event", "visit"], properties: {
      event: { type: "string", enum: ["visit", "open", "ready", "close", "error", "online", "offline", "visible", "hidden", "pagehide", "resource_error", "js_error", "first_message", "caught_up", "recovery_paint", "navigation", "resources_ready", "network_change"] },
      visit: { type: "string", format: "uuid" }, session: { type: "string", format: "uuid" }, document: { type: "string", format: "uuid" },
      build: { type: "string", pattern: "^[a-f0-9]{12}$" }, mode: { type: "string", enum: ["full", "lite"] },
      standalone: { type: "boolean" }, online: { type: "boolean" }, visible: { type: "boolean" },
      elapsedMs: { type: "integer", minimum: 0, maximum: 2147483647 }, durationMs: { type: "integer", minimum: 0, maximum: 2147483647 },
      code: { type: "integer", minimum: 0, maximum: 4999 }, attempt: { type: "integer", minimum: 0, maximum: 1000000 },
      resumed: { type: "boolean" },
      networkType: { type: "string", enum: ["wifi", "cellular", "ethernet", "none", "unknown", "other", "bluetooth", "wimax"] },
      effectiveType: { type: "string", enum: ["slow-2g", "2g", "3g", "4g"] },
      ...Object.fromEntries(["rttMs", "downlinkKbps", "replayEvents", "replayBytes", "foregroundMs", "assetCount", "assetsComplete", "assetTransferBytes", "assetEncodedBytes", "assetsEndMs", "dnsMs", "connectMs", "tlsMs", "ttfbMs", "htmlEndMs", "domReadyMs", "navigationTransferBytes", "navigationMs"].map(name => [name, { type: "integer", minimum: 0, maximum: 2147483647 }])),
    } } },
  }, async (request, reply) => {
    const body = request.body as Record<string, any>;
    const { event, visit, session, document, ...measurements } = body;
    monitoring.event(`client.${event}`, { ...requestFields(request.raw), ...measurements, visit: identity(visit), session: identity(session), document: identity(document) });
    return reply.code(204).send();
  });
  await registerSub2ApiUsage(app);
  await registerLocalProfile(app);
  await registerFeatureConfig(app);
  const websocketServer = new WebSocketServer({
    noServer: true,
    // Desktop sends multi-megabyte feature snapshots at startup. Use the
    // standard WebSocket extension rather than changing message semantics.
    perMessageDeflate: {
      threshold: 1024,
      serverNoContextTakeover: true,
      clientNoContextTakeover: true,
      concurrencyLimit: 2,
      zlibDeflateOptions: { level: 3 },
    },
  });

  await app.register(fastifyMultipart, {
    limits: {
      fileSize: Infinity,
    },
  });

  const uploadRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-web-uploads-"),
  );

  app.post("/__backend/upload", async (request, reply) => {
    if (!request.isMultipart()) {
      return reply.code(400).send({ error: "expected multipart upload body" });
    }

    const files = await Array.fromAsync(
      (async function* () {
        for await (const part of request.files()) {
          const label = part.filename?.trim() || "upload";

          const uploadedPath = path.join(uploadRoot, randomUUID());

          await fs.writeFile(uploadedPath, await part.toBuffer());

          yield {
            label,
            path: uploadedPath,
            fsPath: uploadedPath,
          };
        }
      })(),
    );

    return reply.send({ files });
  });

  await app.register(fastifyStatic, {
    root: "/",
    prefix: "/@fs/",
    decorateReply: false,
  });

  await app.register(fastifyStatic, {
    root: path.resolve(__dirname, "../../scratch/asar/webview"),
    prefix: "/",
  });

  app.get("/", async (_request, reply) => {
    return reply.sendFile("index.html");
  });

  app.get('/lite', async (_request, reply) => reply.redirect('/lite/'));
  app.get('/lite/', async (_request, reply) => reply.sendFile('lite/index.html'));

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/@fs/") || request.url.startsWith("/assets/") || request.url.startsWith("/lite/assets/")) {
      return reply.code(404).send({ error: "Not Found" });
    }

    if (request.method === "GET") {
      if(request.url.startsWith('/lite/')) return reply.sendFile('lite/index.html');
      return reply.sendFile("index.html");
    }
    return reply.code(404).send({ error: "Not Found" });
  });

  const browserStreamUpgrade = createBrowserStreamUpgrade(monitoring);
  app.server.on("upgrade", (request, socket, head) => {
    const requestUrl = request.url ?? "/";
    const host = request.headers.host ?? "localhost";
    const url = new URL(requestUrl, `http://${host}`);
    if (url.pathname === "/__backend/native/browser-stream") {
      browserStreamUpgrade(request, socket, head);
      return;
    }
    if (url.pathname !== "/__backend/native/ipc") {
      monitoring.event("ws.rejected", { ...requestFields(request), reason: "unknown_route" });
      socket.destroy();
      return;
    }

    websocketServer.handleUpgrade(request, socket, head, (upgradedSocket) => {
      websocketServer.emit("connection", upgradedSocket, request);
    });
  });

  const rendererChannels = new Map<number, (message: MainToRendererMessage) => void>();
  const rendererWindowFactory = new Promise<() => Promise<RendererWindow>>(
    resolve => { bridgeState.setRendererWindowFactory = resolve; });
  bridgeState.sendToRenderer = (id, message) => rendererChannels.get(id)?.(message);
  type View = { window: RendererWindow; ports: Map<string, WebSocketMessagePort>;
    encoder: PersistedStateEncoder; send: (message: MainToRendererMessage) => void };
  const rendererSessions = new RendererSessions<View>(async () => ({
    window: await (await rendererWindowFactory)(), ports: new Map(),
    encoder: new PersistedStateEncoder(), send: () => {},
  }), view => {
    rendererChannels.delete(view.window.webContents.id);
    for (const port of [...view.ports.values()]) port.disconnect();
    view.window.destroy();
  }, undefined, (event, id, document, fields) => monitoring.event(`session.${event}`, { session: identity(id), document: identity(document), ...fields }));
  const statsigCache = new StatsigCache();
  websocketServer.on("connection", (socket, request) => {
    const trace = monitoring.connection("ipc", socket, request);
    socket.on("error", () => socket.terminate());
    const params = new URL(request.url!, "http://localhost").searchParams;
    const reset = (reason: string) => {
      trace.event("rejected", { reason });
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({type:"renderer-reset",reason}));
      socket.close(4001, "Renderer reset required");
    };
    if (params.get("lifecycle") !== "3") { reset("页面版本已更新，请重新加载"); return; }
    const sessionId=params.get("session"), documentId=params.get("document");
    if (!sessionId || !documentId || !/^[0-9a-f-]{36}$/.test(sessionId) || !/^[0-9a-f-]{36}$/.test(documentId)) {
      reset("页面身份无效"); return;
    }
    const statsig=params.get("statsig")==="1"?statsigCache.connect():null;
    if(statsig) socket.send(JSON.stringify(statsig.hint));
    const sendFrame=(frame:unknown)=>{
      if(socket.readyState!==WebSocket.OPEN)return;
      socket.send(JSON.stringify(frame));
    };
    let lease: ReturnType<typeof rendererSessions.attach>;
    try {
      lease=rendererSessions.attach(sessionId,documentId,params.get("epoch"),Number(params.get("ack")||0),socket,
        {send:sendFrame,close:()=>socket.close(4001,"Renderer connection replaced")});
    } catch(error) { statsig?.close(); reset(String(error));return; }
    trace.event("attached", { reused: lease.reused });
    let alive=true;
    const heartbeat=setInterval(()=>{if(!alive){trace.event("heartbeat_timeout");socket.terminate();return;}alive=false;socket.ping();},30_000);
    heartbeat.unref();
    // No short visibility deadline: a hidden/frozen document is recoverable.
    socket.on("pong",()=>{alive=true});
    socket.once("close",(code,reason)=>{
      clearInterval(heartbeat);statsig?.close();
      if(code===1000 && reason.toString()==="Document closed")lease.expire("页面已关闭");
      else lease.release();
    });
    let rendererWindow: RendererWindow | undefined;
    let messagePorts: Map<string,WebSocketMessagePort>;
    let send: (message: MainToRendererMessage) => void;
    const rendererReady=lease.window.then(view=>{
      if(!lease.isCurrent())return undefined;
      rendererWindow=view.window;messagePorts=view.ports;
      view.send=message=>lease.send(params.get("stateDelta")==="1"?view.encoder.encode(message):message);
      send=view.send;
      rendererChannels.set(view.window.webContents.id,view.send);
      console.info("[renderer-session] attached",{windowId:view.window.id,reused:lease.reused});
      if(socket.readyState===WebSocket.OPEN) { lease.ready(); trace.event("ready", { reused: lease.reused }); }
      return view;
    }).catch(error=>{trace.event("renderer_error", errorFields(error));lease.expire("页面初始化失败");console.error("[ipc-bridge] renderer creation failed",error);return undefined;});

    const dispatchPostMessage = (
      channel: string,
      message: unknown,
      ports: WebSocketMessagePort[],
      windowId: number,
    ): void => {
      const handler = bridgeState.handleRendererPostMessage;
      if (handler) {
        handler(channel, message, ports, windowId);
        return;
      }

      console.error(
        `[ipc-bridge] no ipcMain postMessage handler for channel ${channel}`,
      );
      for (const port of ports) {
        port.close();
      }
    };

    const dispatchMessage = (message: RendererToMainMessage): void => {
      const window = rendererWindow!;
      if (message.type === "ipc-renderer-send") {
        bridgeState.handleRendererSend?.(
          message.channel,
          message.args,
          window.id,
        );
        return;
      }

      if (message.type === "ipc-renderer-post-message") {
        if (new Set(message.portIds).size !== message.portIds.length) {
          console.error("[ipc-bridge] duplicate transferred MessagePort id");
          return;
        }

        const ports = message.portIds.map((portId) => {
          const existingPort = messagePorts.get(portId);
          if (existingPort) {
            existingPort.disconnect();
          }
          const port = new WebSocketMessagePort(
            portId,
            (message) => {
              send(message);
            },
            () => messagePorts.delete(portId),
          );
          messagePorts.set(portId, port);
          return port;
        });

        dispatchPostMessage(message.channel, message.message, ports, window.id);
        return;
      }

      if (message.type === "message-port-message") {
        messagePorts.get(message.portId)?.receiveMessage(message.data);
        return;
      }

      if (message.type === "message-port-close") {
        messagePorts.get(message.portId)?.disconnect();
        return;
      }

      if (message.type === "workspace-directory-entries-request") {
        const started = performance.now();
        const { requestId } = message;
        getWorkspaceDirectoryEntries(message)
          .then((result) => {
            const durationMs = Math.round(performance.now() - started);
            if (durationMs > 1000) trace.event("handler_slow", { operation: "directory_entries", durationMs });
            const payload: MainToRendererMessage = {
              type: "workspace-directory-entries-result",
              requestId,
              ok: true,
              result,
            };
            send(payload);
          })
          .catch((error) => {
            trace.event("handler_error", { operation: "directory_entries", durationMs: Math.round(performance.now() - started), ...errorFields(error) });
            const payload: MainToRendererMessage = {
              type: "workspace-directory-entries-result",
              requestId,
              ok: false,
              errorMessage: errorMessage(error),
            };
            send(payload);
          });
        return;
      }

      if (message.type === "ipc-renderer-invoke") {
        const started = performance.now();
        const { channel, requestId, args } = message;
        Promise.resolve(
          bridgeState.handleRendererInvoke?.(channel, args, window.id) ??
            Promise.reject(
              new Error(
                `[ipc-bridge] no ipcMain.handle for channel ${channel}`,
              ),
            ),
        )
          .then((result) => {
            const durationMs = Math.round(performance.now() - started);
            if (durationMs > 1000) trace.event("handler_slow", { operation: "invoke", durationMs });
            const payload: MainToRendererMessage = {
              type: "ipc-renderer-invoke-result",
              requestId,
              ok: true,
              result,
            };
            send(payload);
          })
          .catch((error) => {
            trace.event("handler_error", { operation: "invoke", durationMs: Math.round(performance.now() - started), ...errorFields(error) });
            const payload: MainToRendererMessage = {
              type: "ipc-renderer-invoke-result",
              requestId,
              ok: false,
              errorMessage: errorMessage(error),
            };
            send(payload);
          });
      }
    };
    socket.on("message",async raw=>{
      const receivedAt = performance.now();
      const view=await rendererReady;
      if(!view||!lease.isCurrent()||socket.readyState!==WebSocket.OPEN)return;
      try {
        const frame=JSON.parse(String(raw));
        if(frame.type==="renderer-ping"){sendFrame({type:"renderer-pong",id:frame.id});const durationMs=Math.round(performance.now()-receivedAt);if(durationMs>1000)trace.event("ping_delayed",{durationMs});return;}
        if(frame.type==="renderer-ack"){lease.acknowledge(frame.seq);return;}
        if(frame.type!=="renderer-command")throw Error("Invalid renderer frame");
        const message=(statsig?statsig.expand(frame.payload):frame.payload) as RendererToMainMessage;
        lease.accept(frame.seq,()=>dispatchMessage(message));
      } catch(error) {trace.event("invalid_frame",errorFields(error));lease.expire("通信状态异常，请重新加载");console.warn("[ipc-bridge] invalid renderer frame",errorFields(error));}
    });
  });

  return app;
}

async function startIpcBridgeServer(options: ServerOptions): Promise<void> {
  const app = await createBridgeServer();
  await app.listen({ host: options.host, port: options.port });
  console.log(`IPC bridge listening at ws://${options.host}:${options.port}`);

  ensureElectronLikeProcessContext();
  installModuleAliasHook();

  const packageJson = JSON.parse(
    await fs.readFile(
      path.resolve(__dirname, "../../scratch/asar/package.json"),
      "utf8",
    ),
  );

  globalThis.__CODEX_SHIM_VALUES__ = {
    version: packageJson.version,
  };

  // The upstream entrypoint initializes network policy and starts the app once.
  require(path.resolve(__dirname, "../../scratch/asar", packageJson.main));
}

async function main(args: string[]) {
  hideBackgroundProcessWindows();
  const options = parseServerArgs(args);

  await startIpcBridgeServer(options);
}

if (require.main === module) {
  const logging = processLogging = installProcessLogging(path.resolve(__dirname, "../../runtime/console"));
  process.once("beforeExit", () => { void logging.close(); });
  main(process.argv.slice(2)).catch(async error => {
    console.error(error);
    await logging.close();
    process.exitCode = 1;
  });
}
