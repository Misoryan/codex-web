import type { Workflow } from "./store";
import path from "node:path";

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

export async function workflowSnapshot(id: string) {
  const manager = workflowManager();
  const conversation = manager.getConversation(id);
  if (!conversation) {
    const client = workflowHost().getLocalAppServerClient();
    const thread = await client.readThread(id, { includeTurns: false });
    return { runtime: thread.status?.type ?? "unknown" };
  }
  const turns = conversation.turnHistory?.kind === "canonical"
    ? conversation.turnHistory.history.islands.flatMap((island: any) => island.entries.map((entry: any) => conversation.turnHistory.history.entitiesByKey[entry.value]))
    : conversation.turns;
  const lastTurn = turns?.at(-1);
  const messages = lastTurn?.items?.filter((item: any) => item.type === "agentMessage");
  return { runtime: conversation.threadRuntimeStatus?.type ?? lastTurn?.status ?? "idle",
    lastMessage: messages?.at(-1)?.text?.slice(-24000) ?? "",
    pending: conversation.requests?.length ?? 0 };
}
