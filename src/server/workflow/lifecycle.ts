import path from "node:path";
import { PublicationMonitor } from "./publication";
import { command, inspectDelivery, removeWorktree } from "./git";
import { within } from "./indexer";
import { workflowHost, workflowManager, workflowSnapshot } from "./host";
import type { Workflow, WorkflowStore } from "./store";
import { refreshRemoteWorktrees, cleanRemoteWorktrees } from "./remote-worktrees";

export class WorkflowLifecycle {
  private locks = new Set<string>();
  private pending = new Set<Promise<unknown>>();
  private publication: PublicationMonitor;
  constructor(private store: WorkflowStore, private cwd: string) { this.publication = new PublicationMonitor(store); }
  refreshPublications(force = false) { return this.publication.refresh(force); }
  invalidatePublication() { this.publication.invalidate(); }
  isBusy(id: string) { return this.locks.has(id) || this.publication.isBusy(id); }
  async drain() { await Promise.allSettled([...this.pending]); }

  async assertIdle(task: Workflow, target?: string, allowUnloaded = false) {
    const tasks = this.store.list().filter(other => other.threadId && !other.archivedAt &&
      (other.id === task.id || target && (within(target, other.cwd) || other.worktrees.some(w => w.path === target))));
    for (const other of tasks) {
      const state = await workflowSnapshot(other.threadId!);
      if (state.pending || !["idle", "completed", "interrupted", "failed", ...(allowUnloaded ? ["notLoaded"] : [])].includes(state.runtime)) throw Error("对应会话仍在运行或等待回应，或状态尚未确认");
    }
    if (target) {
      const client = workflowHost().getLocalAppServerClient();
      let cursor: string | null = null;
      do {
        const page: any = await client.listThreads({ limit: 100, cursor, sortKey: "updated_at", archived: false, useStateDbOnly: true });
        for (const thread of page.data) {
          if (!within(target, thread.cwd)) continue;
          const state = await workflowSnapshot(thread.id);
          if (state.pending || !["idle", "completed", "interrupted", "failed", ...(allowUnloaded ? ["notLoaded"] : [])].includes(state.runtime)) throw Error("工作区中还有运行中的会话，或状态尚未确认");
        }
        cursor = page.nextCursor ?? null;
      } while (cursor);
    }
  }

  private async release(task: Workflow, manual = false) {
    if (!manual && (!task.managed || task.publication?.error || !task.deliveries.length || !task.deliveries.every(d => d.devMergedAt && (!d.error || d.error === "发布分支暂时无法核对")))) return;
    if (task.cleanup.state === "released") return;
    this.store.update(task.id, { cleanup: { state: "pending", reason: "等待会话空闲后释放", checkedAt: new Date().toISOString() } });
    try {
      await this.assertIdle(task, undefined, manual);
      if (manual && task.remoteWorktrees?.some(worktree => worktree.cleanup.state === "unregistered")) {
        throw Error("远端工作区尚未登记回收，请先在对应会话完成交付并登记回收");
      }
      if (manual && task.worktrees.some(worktree => !worktree.releasedAt) &&
          (!task.deliveries.length || task.deliveries.some(delivery => !delivery.devMergedAt))) throw Error("任务工作区的交付尚未全部合入，请先合入后再清理");
      const resourceOrder = task.resources.map((resource, index) => ({ resource, index }))
        .sort((a, b) => Number(a.resource.kind === "bbdev-lease") - Number(b.resource.kind === "bbdev-lease"));
      for (const { index } of resourceOrder) {
        const resource = this.store.get(task.id)!.resources[index]!;
        if (resource.released) continue;
        const helper = process.env.CODEX_WORKFLOW_RESOURCE_HELPER;
        if (!helper) throw Error("测试资源释放服务未配置");
        const result = JSON.parse(await command(process.env.CODEX_WORKFLOW_PYTHON ?? "python",
          ["-X", "utf8", helper, "--kind", resource.kind, "--task", resource.task, "--lease", resource.lease,
            ...(resource.slot ? ["--slot", String(resource.slot)] : [])]));
        if (!result.released) throw Error(result.error ?? "测试资源仍在使用");
        const resources = [...this.store.get(task.id)!.resources]; resources[index] = { ...resource, released: true };
        this.store.update(task.id, { resources }, "resource.released");
      }
      for (let index = 0; index < task.worktrees.length; index++) {
        const worktree = this.store.get(task.id)!.worktrees[index]!;
        if (worktree.releasedAt) continue;
        await this.assertIdle(this.store.get(task.id)!, worktree.path, manual);
        await removeWorktree(worktree, this.cwd, task.deliveries, value => {
          const worktrees = [...this.store.get(task.id)!.worktrees]; worktrees[index] = value;
          this.store.update(task.id, { worktrees }, value.releasedAt ? "worktree.released" : undefined);
        }, () => this.assertIdle(this.store.get(task.id)!, worktree.path, manual));
      }
      const projects = workflowHost().projectsManager;
      if (!projects) throw Error("原生项目管理器尚未就绪");
      for (const project of Object.values(projects.getLocalProjects()) as any[]) {
        if (project.rootPaths?.length !== 1) continue;
        const root = path.resolve(project.rootPaths[0]);
        if (root.toLowerCase() === path.resolve(this.cwd).toLowerCase()) continue;
        if (!task.worktrees.some(w => path.resolve(w.path).toLowerCase() === root.toLowerCase())) continue;
        const other = this.store.list().find(t => t.id !== task.id && !t.archivedAt && within(root, t.cwd));
        if (other) throw Error("临时项目仍被其他事项使用");
        await this.assertIdle(this.store.get(task.id)!, root, manual);
        await projects.removeLocal(project.id);
        if (projects.getLocalProjects()[project.id]) throw Error("临时项目入口仍存在");
        this.store.update(task.id, { projectsRemoved: [...this.store.get(task.id)!.projectsRemoved, project.id] });
      }
      if (manual) {
        await this.assertIdle(this.store.get(task.id)!, undefined, true);
        await cleanRemoteWorktrees(this.store, task.id);
      }
      const current = this.store.get(task.id)!;
      if (current.remoteWorktreesSync?.error || current.remoteWorktrees?.some(worktree => worktree.cleanup.state !== "cleaned")) {
        this.store.update(task.id, { cleanup: { state: "pending", reason: current.remoteWorktreesSync?.error || current.remoteWorktrees?.find(worktree => worktree.cleanup.state !== "cleaned")?.cleanup.reason || "远端工作区等待 bbdev 回收确认", checkedAt: new Date().toISOString() } });
        return;
      }
      this.store.update(task.id, { cleanup: { state: "released", reason: "", releasedAt: new Date().toISOString() } }, "resources.released");
    } catch (error) {
      this.store.update(task.id, { cleanup: { state: "blocked", reason: (error as Error).message, checkedAt: new Date().toISOString() } }, "cleanup.blocked");
    }
  }

  archiveAndClean(id: string) {
    const operation = this.runArchiveAndClean(id).finally(() => this.pending.delete(operation));
    this.pending.add(operation);
    return operation;
  }

  private async archiveConversation(task: Workflow, manual = false) {
    if (!task.threadId) throw Error("事项尚未关联会话");
    await this.assertIdle(task, undefined, manual);
    await workflowManager().archiveConversation(task.threadId, { useAppServerPins: true, source: "archive_directive" });
    const observed = await workflowHost().getLocalAppServerClient().readThread(task.threadId, { includeTurns: false });
    if (observed.archivedAt == null && observed.archived !== true) {
      const page = await workflowHost().getLocalAppServerClient().listThreads({ limit: 100, cursor: null, archived: true, useStateDbOnly: true });
      if (!page.data.some((thread: any) => thread.id === task.threadId)) throw Error("会话归档结果尚未确认");
    }
    return this.store.update(task.id, { archivedAt: new Date().toISOString(), error: null }, "conversation.archived");
  }

  private async runArchiveAndClean(id: string) {
    if (this.locks.has(id)) throw Error("正在核对该事项，请稍后重试");
    this.locks.add(id);
    try {
      let task = this.store.get(id)!;
      if (task.archivedAt) return task;
      if (!task.threadId) throw Error("事项尚未关联会话");
      const shared = this.store.list().some(other => other.id !== id && !other.archivedAt && (
        task.worktrees.some(worktree => !worktree.releasedAt && (within(worktree.path, other.cwd) ||
          other.worktrees.some(value => !value.releasedAt && path.resolve(value.path).toLowerCase() === path.resolve(worktree.path).toLowerCase()))) ||
        task.remoteWorktrees?.some(worktree => worktree.cleanup.state !== "cleaned" && other.remoteWorktrees?.some(value =>
          value.cleanup.state !== "cleaned" && value.host === worktree.host && value.task === worktree.task && value.path === worktree.path))));
      if (shared) throw Error("工作区仍被其他事项关联，保留工作区与会话");
      await this.assertIdle(task, undefined, true);
      await refreshRemoteWorktrees(this.store, id, true);
      task = this.store.get(id)!;
      if (task.worktrees.some(worktree => !worktree.releasedAt)) {
        const deliveries = [];
        for (const delivery of task.deliveries) deliveries.push(await inspectDelivery(delivery));
        task = this.store.update(id, { deliveries }, "delivery.checked");
      }
      await this.release(task, true);
      task = this.store.get(id)!;
      if (task.cleanup.state !== "released" || task.worktrees.some(worktree => !worktree.releasedAt) ||
          task.resources.some(resource => !resource.released) || task.remoteWorktreesSync?.error ||
          task.remoteWorktrees?.some(worktree => worktree.cleanup.state !== "cleaned")) {
        throw Error(task.cleanup.reason || "工作区尚未清理完成，保留会话");
      }
      return await this.archiveConversation(task, true);
    } catch (error) {
      this.store.update(id, { error: (error as Error).message });
      throw error;
    } finally { this.locks.delete(id); }
  }

  reconcile(id: string, archive = true) {
    const operation = this.run(id, archive).finally(() => this.pending.delete(operation));
    this.pending.add(operation);
    return operation;
  }

  private async run(id: string, archive: boolean) {
    if (this.locks.has(id)) return this.store.get(id);
    const initial = this.store.get(id);
    if (!initial || initial.archivedAt) return initial;
    await refreshRemoteWorktrees(this.store, id);
    await this.publication.refresh();
    if (this.locks.has(id)) return this.store.get(id);
    this.locks.add(id);
    try {
      let task = this.store.get(id)!;
      if (!task || task.archivedAt) return task;
      await this.release(task);
      task = this.store.get(id)!;
      const done = task.stage === "done" && task.status === "completed" && !task.publication?.error && !task.publication?.issues.some(issue => (issue.isLeaf !== false || issue.number === task.issue?.number) && (issue.status !== "DONE" || issue.error));
      if (done && task.managed) task = this.store.update(id, { stage: "done", status: "completed" });
      if (archive && done && task.managed && (!task.issue || task.mobius.status === "DONE") &&
          !task.remoteWorktreesSync?.error && (!task.remoteWorktrees?.length || task.remoteWorktrees.every(worktree => worktree.cleanup.state === "cleaned")) &&
          (!task.worktrees.length && !task.resources.length || task.cleanup.state === "released") && task.threadId) {
        try {
          await this.archiveConversation(task);
        } catch (error) { this.store.update(id, { error: (error as Error).message }); }
      }
      return this.store.get(id);
    } finally { this.locks.delete(id); }
  }
}
