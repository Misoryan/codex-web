import { command } from "./git";
import path from "node:path";
import type { RemoteWorktree, Resource, WorkflowStore } from "./store";
import { remoteCleanupStates } from "./store";

export type RemoteRegistration = Pick<RemoteWorktree, "host" | "task" | "path">;
const refreshing = new Set<string>();
const snapshot = (task: ReturnType<WorkflowStore["get"]>) => JSON.stringify([task?.remoteWorktrees, task?.resources, task?.remoteWorktreesSync]);
export async function inspectRemoteWorktrees(worktrees: RemoteRegistration[], resources: Resource[], cleanup = false) {
  const helper = process.env.CODEX_WORKFLOW_REMOTE_WORKTREES_HELPER;
  if (!helper) throw Error("远端工作区核对服务未配置");
  const result = JSON.parse(await command(process.env.CODEX_WORKFLOW_PYTHON ?? "python",
    ["-X", "utf8", helper, "--request", JSON.stringify({ worktrees, ...(cleanup ? { cleanup: true } : {}),
      resources: resources.filter(resource => resource.kind === "bbdev-lease") })]));
  if (!Array.isArray(result.worktrees)) throw Error("远端工作区核对结果不完整");
  for (const worktree of result.worktrees) {
    if (worktree.host !== "bbdev" || typeof worktree.task !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(worktree.task) ||
        typeof worktree.path !== "string" || !path.posix.isAbsolute(worktree.path) || path.posix.normalize(worktree.path) !== worktree.path ||
        typeof worktree.branch !== "string" || typeof worktree.head !== "string" || !/^[a-f0-9]{40}$/.test(worktree.head) ||
        !remoteCleanupStates.includes(worktree.cleanup?.state) || typeof worktree.cleanup?.reason !== "string" ||
        worktree.cleanup.checkedAt !== null && (typeof worktree.cleanup.checkedAt !== "string" || !Number.isFinite(Date.parse(worktree.cleanup.checkedAt)))) {
      throw Error("远端工作区核对结果不完整");
    }
    if (!worktrees.some(item => item.host === worktree.host && item.task === worktree.task && item.path === worktree.path) &&
        !resources.some(item => item.kind === "bbdev-lease" && item.task === worktree.task)) throw Error("远端工作区来源未登记");
  }
  if (new Set(result.worktrees.map((value: RemoteWorktree) => value.path)).size !== result.worktrees.length) throw Error("远端工作区记录重复");
  if (worktrees.some(item => !result.worktrees.some((value: RemoteWorktree) =>
      value.host === item.host && value.task === item.task && value.path === item.path))) throw Error("已登记的远端工作区未返回");
  return result.worktrees as RemoteWorktree[];
}

export async function cleanRemoteWorktrees(store: WorkflowStore, id: string) {
  const task = store.get(id)!;
  if (!task.remoteWorktrees?.some(worktree => worktree.cleanup.state !== "cleaned")) return;
  const remoteWorktrees = await inspectRemoteWorktrees(task.remoteWorktrees, task.resources, true);
  store.update(id, { remoteWorktrees, remoteWorktreesSync: { checkedAt: new Date().toISOString(), error: null } }, "remote-worktrees.checked");
}

export async function refreshRemoteWorktrees(store: WorkflowStore, id: string, force = false) {
  const task = store.get(id);
  if (!task) return;
  if (refreshing.has(id)) { if (force) throw Error("远端工作区正在核对，请稍后重试"); return; }
  if (!task.remoteWorktrees?.length && !task.resources.some(resource => resource.kind === "bbdev-lease")) return;
  if (!force && task.remoteWorktreesSync && Date.now() - Date.parse(task.remoteWorktreesSync.checkedAt) < 30000) return;
  const checkedAt = new Date().toISOString();
  const before = snapshot(task);
  refreshing.add(id);
  try {
    const worktrees = (task.remoteWorktrees ?? []).map(({ host, task, path }) => ({ host, task, path }));
    const remoteWorktrees = await inspectRemoteWorktrees(worktrees, task.resources);
    if (snapshot(store.get(id)) !== before) return;
    store.update(id, { remoteWorktrees, remoteWorktreesSync: { checkedAt, error: null } }, "remote-worktrees.checked");
  } catch {
    if (snapshot(store.get(id)) !== before) return;
    store.update(id, { remoteWorktreesSync: { checkedAt, error: "远端工作区尚未核对，保留上次记录" } });
  } finally { refreshing.delete(id); }
}
