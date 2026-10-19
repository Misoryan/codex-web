import type { Workflow } from "./store";
import path from "node:path";
import { RuntimeReader, readLoadedRuntime, runtimeState } from "./runtime-reader";
import type { RuntimeBatch, RuntimeState } from "./runtime-reader";

export function workflowHost() { return (globalThis as any).__codexWorkflowHost; }
export function workflowManager() {
  const context = workflowHost();
  if (!context?.appServerManagersService) throw Error("共享会话管理器尚未就绪");
  const entry = context.hostAppServerManagers.getCurrent("local");
  if (!entry?.resource?.manager) throw Error("本机会话服务尚未就绪");
  return entry.resource.manager;
}

export async function createWorkflowThread(task: Workflow, prompt: string, onCreated: (id: string) => void) {
  const manager = workflowManager();
  const projects = workflowHost().options.globalState.get("local-projects") ?? {};
  const project: any = Object.values(projects).find((project: any) => project.rootPaths?.some((root: string) => path.resolve(root).toLowerCase() === path.resolve(task.cwd).toLowerCase()));
  if (!project) throw Error("请先在 Codex 中添加工作流项目目录");
  const result = await manager.startConversation({
    input: [{ type: "text", text: prompt, text_elements: [] }],
    cwd: task.cwd, workspaceRoots: [task.cwd], workspaceKind: "project",
    initialTitle: task.title, mode: "default", threadSource: "user", threadStartKind: "default",
    projectAssignment: { projectKind: "local", projectId: project.id },
    useAppServerPermissionDefault: true,
  }, {
    readThreadCreationInputs: async () => ({
      hasDesktopRuntime: true, hasDeveloperInstructions: true, isBrowserRuntime: false,
      everydayWork: true, usesDesktopMcp: true, sidebarSectionToolsEnabled: false,
      readDynamicTools: async () => [],
    }),
    afterConversationCreated: async (id: string) => { onCreated(id); },
  });
  if (result.conversationId) {
    onCreated(result.conversationId);
    await manager.setThreadTitle(result.conversationId, task.title);
  }
  if (result.status !== "created" || result.firstTurn?.status !== "accepted") {
    throw Error(result.firstTurn?.message ?? `工作发送结果：${result.firstTurn?.status ?? result.status}`);
  }
  return result;
}

let observers: RuntimeReader[] | undefined;
function runtimeObservers() {
  return observers ??= (process.env.CODEX_WORKFLOW_OBSERVER_IPC_URLS ?? "").split(",").map(url => url.trim()).filter(Boolean).map(url => new RuntimeReader(url));
}
export function closeRuntimeObservers() { observers?.forEach(observer => observer.close()); observers = undefined; }

function conversationDetails(id: string) {
  const manager = workflowManager();
  const conversation = manager.getConversation(id);
  if (!conversation) return {};
  const turns = conversation.turnHistory?.kind === "canonical"
    ? conversation.turnHistory.history.islands.flatMap((island: any) => island.entries.map((entry: any) => conversation.turnHistory.history.entitiesByKey[entry.value]))
    : conversation.turns;
  const lastTurn = turns?.at(-1);
  const messages = lastTurn?.items?.filter((item: any) => item.type === "agentMessage");
  return { lastMessage: messages?.at(-1)?.text?.slice(-24000) ?? "", pending: conversation.requests?.length ?? 0 };
}

export async function workflowSnapshots(ids: readonly string[]) {
  const client = workflowHost().getLocalAppServerClient();
  const deadline = <T>(work: Promise<T>) => new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("Native runtime read timed out")), 5000);
    work.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
  const batches: RuntimeBatch[] = await Promise.all([
    readLoadedRuntime(ids, (method, params) => deadline(client.sendAppServerRequest(method, params))),
    ...runtimeObservers().map(observer => observer.snapshot(ids)),
  ]);
  const result = new Map<string, RuntimeState & { runtimeCheckedAt: string; lastMessage?: string }>();
  for (const id of ids) {
    const observed = batches.map(batch => batch.states.get(id)).filter((state): state is RuntimeState => Boolean(state));
    const active = observed.filter(state => state.runtime === "active");
    const known = observed.find(state => !["unknown", "notLoaded"].includes(state.runtime));
    let state: RuntimeState;
    if (active.length) state = { runtime: "active", activeFlags: [...new Set(active.flatMap(state => state.activeFlags))], pending: Math.max(...active.map(state => state.pending)) };
    else if (batches.some(batch => !batch.available) || observed.some(state => state.runtime === "unknown")) state = runtimeState(null);
    else if (known) state = known;
    else state = runtimeState({ type: batches.every(batch => batch.available) && observed.every(state => state.runtime !== "unknown") ? "notLoaded" : "unknown" });
    const details = conversationDetails(id);
    result.set(id, { ...details, ...state, pending: ["active", "idle"].includes(state.runtime) ? Math.max(state.pending, details.pending ?? 0) : state.pending, runtimeCheckedAt: new Date().toISOString() });
  }
  return result;
}

export async function workflowSnapshot(id: string) { return (await workflowSnapshots([id])).get(id)!; }
