import path from "node:path";
import { command, inspectDelivery, removeWorktree } from "./git";
import { within } from "./indexer";
import { workflowHost, workflowManager, workflowSnapshot } from "./host";
import type { Workflow, WorkflowStore } from "./store";

export function desiredIssueStatus(task: Workflow) {
  if (task.deliveries.some(delivery => delivery.error)) return null;
  if (task.deliveries.length) {
    if (task.deliveries.every(delivery => delivery.masterMergedAt)) return "DONE";
    if (task.deliveries.every(delivery => delivery.devMergedAt)) return "READY_FOR_RELEASE";
    if (task.stage === "done") return "READY_FOR_TEST";
  } else if (task.stage === "done" && task.kind === "research" && task.status === "completed") return "DONE";
  if (["verification", "delivery"].includes(task.stage)) return "READY_FOR_TEST";
  if (task.status === "blocked") return "BLOCKED";
  if (task.stage === "implementation") return "IN_PROGRESS";
  return null;
}

export class WorkflowLifecycle {
  private locks = new Set<string>();
  private pending = new Set<Promise<unknown>>();
  constructor(private store: WorkflowStore, private cwd: string) {}
  isBusy(id: string) { return this.locks.has(id); }
  async drain() { await Promise.allSettled([...this.pending]); }

  async assertIdle(task: Workflow, target?: string) {
    const tasks = this.store.list().filter(other => other.threadId && !other.archivedAt &&
      (other.id === task.id || target && (within(target, other.cwd) || other.worktrees.some(w => w.path === target))));
    for (const other of tasks) {
      const state = await workflowSnapshot(other.threadId!);
      if (state.pending || !["idle", "completed", "interrupted", "failed"].includes(state.runtime)) throw Error("对应会话仍在运行或等待回应");
    }
    if (target) {
      const client = workflowHost().getLocalAppServerClient();
      let cursor: string | null = null;
      do {
        const page: any = await client.listThreads({ limit: 100, cursor, sortKey: "updated_at", archived: false, useStateDbOnly: true });
        for (const thread of page.data) {
          if (!within(target, thread.cwd)) continue;
          const state = await workflowSnapshot(thread.id);
          if (state.pending || !["idle", "completed", "interrupted", "failed"].includes(state.runtime)) throw Error("工作区中还有运行中的会话");
        }
        cursor = page.nextCursor ?? null;
      } while (cursor);
    }
  }

  private async syncIssue(task: Workflow) {
    if (!task.issue) return;
    const desired = task.managed ? desiredIssueStatus(task) : null;
    try {
      const helper = process.env.CODEX_WORKFLOW_MOBIUS_HELPER;
      if (!helper) throw Error("Möbius 同步服务未配置");
      const result = JSON.parse(await command(process.env.CODEX_WORKFLOW_PYTHON ?? "python",
        ["-X", "utf8", helper, "--number", String(task.issue.number), ...(desired ? ["--desired", desired] : [])]));
      this.store.update(task.id, { mobius: { status: result.status, desired, checkedAt: new Date().toISOString(), error: null } },
        result.status !== task.mobius.status ? "issue.synced" : undefined);
    } catch (error) {
      let reason = "暂时无法连接同步服务";
      try { reason = JSON.parse((error as any).stdout).error ?? reason; } catch { /* Keep subprocess details out of the page. */ }
      this.store.update(task.id, { mobius: { ...task.mobius, desired, error: "Möbius 状态未同步：" + reason } });
    }
  }

  private async release(task: Workflow) {
    if (!task.managed || !task.deliveries.length || !task.deliveries.every(d => d.devMergedAt)) return;
    if (task.cleanup.state === "released") return;
    this.store.update(task.id, { cleanup: { state: "pending", reason: "等待会话空闲后释放", checkedAt: new Date().toISOString() } });
    try {
      await this.assertIdle(task);
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
        await this.assertIdle(this.store.get(task.id)!, worktree.path);
        await removeWorktree(worktree, this.cwd, task.deliveries, value => {
          const worktrees = [...this.store.get(task.id)!.worktrees]; worktrees[index] = value;
          this.store.update(task.id, { worktrees }, value.releasedAt ? "worktree.released" : undefined);
        }, () => this.assertIdle(this.store.get(task.id)!, worktree.path));
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
        await this.assertIdle(this.store.get(task.id)!, root);
        await projects.removeLocal(project.id);
        if (projects.getLocalProjects()[project.id]) throw Error("临时项目入口仍存在");
        this.store.update(task.id, { projectsRemoved: [...this.store.get(task.id)!.projectsRemoved, project.id] });
      }
      this.store.update(task.id, { cleanup: { state: "released", reason: "", releasedAt: new Date().toISOString() } }, "resources.released");
    } catch (error) {
      this.store.update(task.id, { cleanup: { state: "blocked", reason: (error as Error).message, checkedAt: new Date().toISOString() } }, "cleanup.blocked");
    }
  }

  reconcile(id: string, archive = true) {
    const operation = this.run(id, archive).finally(() => this.pending.delete(operation));
    this.pending.add(operation);
    return operation;
  }

  private async run(id: string, archive: boolean) {
    if (this.locks.has(id)) return this.store.get(id);
    this.locks.add(id);
    try {
      let task = this.store.get(id)!;
      if (!task || task.archivedAt) return task;
      const deliveries = [];
      for (const delivery of task.deliveries) {
        try { deliveries.push(await inspectDelivery(delivery)); }
        catch { deliveries.push({ repo: delivery.repo, pr: delivery.pr, url: delivery.url, base: delivery.base, release: delivery.release, error: "GitHub 交付记录暂时无法核对" }); }
      }
      task = this.store.update(id, { deliveries }, "delivery.checked");
      await this.syncIssue(task);
      task = this.store.get(id)!;
      await this.release(task);
      task = this.store.get(id)!;
      const done = task.deliveries.length ? task.deliveries.every(d => d.masterMergedAt) : task.kind === "research" && task.stage === "done" && task.status === "completed";
      if (done && task.managed) task = this.store.update(id, { stage: "done", status: "completed" });
      if (archive && done && task.managed && (!task.issue || task.mobius.status === "DONE") &&
          (!task.worktrees.length && !task.resources.length || task.cleanup.state === "released") && task.threadId) {
        try {
          await this.assertIdle(task);
          await workflowManager().archiveConversation(task.threadId, { useAppServerPins: true, source: "archive_directive" });
          const observed = await workflowHost().getLocalAppServerClient().readThread(task.threadId, { includeTurns: false });
          if (observed.archivedAt == null && observed.archived !== true) {
            const page = await workflowHost().getLocalAppServerClient().listThreads({ limit: 100, cursor: null, archived: true, useStateDbOnly: true });
            if (!page.data.some((thread: any) => thread.id === task.threadId)) throw Error("会话归档结果尚未确认");
          }
          this.store.update(id, { archivedAt: new Date().toISOString(), error: null }, "conversation.archived");
        } catch (error) { this.store.update(id, { error: (error as Error).message }); }
      }
      return this.store.get(id);
    } finally { this.locks.delete(id); }
  }
}
