import type { FastifyInstance, FastifyRequest } from "fastify";
import path from "node:path";
import fs from "node:fs/promises";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { WorkflowStore } from "./store";
import { closeRuntimeObservers, createWorkflowThread, workflowHost, workflowManager, workflowSnapshots } from "./host";
import { within, importProjectThreads } from "./indexer";
import { WorkflowLifecycle } from "./lifecycle";
import { WorkflowInbox } from "./inbox";
import { workflowIssueTitle } from "./title";
import { inspectRemoteWorktrees, refreshRemoteWorktrees } from "./remote-worktrees";
import { inspectRegisteredWorktree } from "./git";

const prefix = "/__backend/workflow";
const stages = ["intake", "research", "implementation", "verification", "delivery", "done"];
const kinds = ["feature", "fix", "improvement", "research"];
const reportProperties = {
  title: { type: "string", minLength: 1, maxLength: 200 },
  stage: { type: "string", enum: stages },
  status: { type: "string", enum: ["running", "waiting", "blocked", "completed"] },
  summary: { type: "string", maxLength: 8000 },
  issue: { type: "object", additionalProperties: false, required: ["number"], properties: { number: { type: "integer", minimum: 1, maximum: 100000000 } } },
  project: { type: "string", minLength: 1, maxLength: 100 },
  deliveries: { type: "array", maxItems: 20, items: { type: "object", additionalProperties: false,
    required: ["repo", "pr", "base", "release"], properties: {
      repo: { type: "string", pattern: "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", maxLength: 200 },
      pr: { type: "integer", minimum: 1 }, base: { type: "string", enum: ["dev", "master", "main"] },
      release: { type: "string", enum: ["master", "main"] },
    } } },
  worktrees: { type: "array", maxItems: 20, items: { type: "object", additionalProperties: false,
    required: ["repo", "path", "branch", "head"], properties: {
      repo: { type: "string", minLength: 1, maxLength: 1000 }, path: { type: "string", minLength: 1, maxLength: 1000 },
      branch: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._/-]*$", maxLength: 200 },
      head: { type: "string", pattern: "^[a-f0-9]{40}$" },
    } } },
  remoteWorktrees: { type: "array", maxItems: 20, items: { type: "object", additionalProperties: false,
    required: ["host", "task", "path"], properties: {
      host: { type: "string", const: "bbdev" }, task: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$", maxLength: 200 },
      path: { type: "string", pattern: "^/[^\\u0000]*$", maxLength: 1000 },
    } } },
  resources: { type: "array", maxItems: 20, items: { type: "object", additionalProperties: false,
    required: ["kind", "task", "lease"], properties: {
      kind: { type: "string", enum: ["bbdev-lease", "bedrock-client"] },
      task: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$", maxLength: 200 },
      lease: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$", maxLength: 200 },
      slot: { type: "integer", minimum: 1, maximum: 4 },
    } } },
  evidence: { type: "array", maxItems: 40, items: { type: "object", additionalProperties: false,
    required: ["label", "value"], properties: { label: { type: "string", maxLength: 200 },
      value: { type: "string", maxLength: 4000 }, url: { type: "string", pattern: "^https://", maxLength: 2000 } } } },
};

export async function registerWorkflow(app: FastifyInstance) {
  const configuredCwd = process.env.CODEX_WORKFLOW_CWD;
  if (!configuredCwd) return;
  const cwd: string = configuredCwd;
  const directory = path.resolve(process.env.CODEX_WORKFLOW_DATA ?? path.join(process.env.CODEX_HOME!, "workflow"));
  const store = new WorkflowStore(directory);
  const lifecycle = new WorkflowLifecycle(store, cwd);
  const inbox = new WorkflowInbox(store);
  const agentToken = randomBytes(32).toString("hex");
  const endpoint = process.env.CODEX_WORKFLOW_LOCAL_URL + prefix;
  await fs.writeFile(path.join(directory, "service.json"), JSON.stringify({ endpoint, agentToken }), { mode: 0o600 });
  const allowedOrigins = new Set((process.env.CODEX_WORKFLOW_ORIGINS ?? "").split(",").filter(Boolean));
  let polling = false;
  let checkingWorktrees: Promise<unknown> | undefined;
  let notificationConnection: any, unsubscribe: (() => void) | undefined;
  let refreshing: Promise<void> | undefined;
  let indexing: Promise<void> | undefined;
  function syncThreads() {
    return indexing ??= importProjectThreads(store, cwd, directory).finally(() => { indexing = undefined; });
  }
  function refreshAll(includeImported = false) {
    if (refreshing) return;
    refreshing = (async () => {
      await syncThreads();
      await inbox.refresh(includeImported);
      const tasks = store.list().filter(task => !task.archivedAt && (task.managed || includeImported && task.issue));
      let index = 0;
      await Promise.all(Array.from({ length: 3 }, async () => {
        while (index < tasks.length) await lifecycle.reconcile(tasks[index++]!.id);
      }));
    })().catch(error => app.log.error(error)).finally(() => { refreshing = undefined; });
  }
  async function sameOrigin(request: FastifyRequest, reply: any) {
    const supplied = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
    if (supplied.length === agentToken.length && timingSafeEqual(Buffer.from(supplied), Buffer.from(agentToken))) return;
    const origin = request.headers.origin;
    const localOrigin = `http://${request.headers.host}`;
    if (origin && (origin === localOrigin || allowedOrigins.has(origin))) return;
    return reply.code(403).send({ error: "请从工作流页面执行此操作" });
  }
  app.get(prefix + "/health", async () => {
    try { workflowManager(); return { ready: true, cwd }; }
    catch (error) { return { ready: false, cwd, error: (error as Error).message }; }
  });
  app.get(prefix, async () => { await syncThreads(); return store.list(); });
  app.get(prefix + "/inbox", async () => inbox.snapshot());
  app.post(prefix + "/attach", { schema: { body: { type: "object", additionalProperties: false,
    required: ["threadId"], properties: { threadId: { type: "string", format: "uuid" } },
  } } }, async (request, reply) => {
    const supplied = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
    if (supplied.length !== agentToken.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(agentToken))) return reply.code(403).send({ error: "本机工作流凭据无效" });
    const { threadId } = request.body as { threadId: string };
    const existing = store.list().find(task => task.threadId === threadId);
    if (existing) return JSON.parse(await fs.readFile(path.join(directory, "contexts", existing.id + ".json"), "utf8"));
    const thread = await workflowHost().getLocalAppServerClient().readThread(threadId, { includeTurns: false });
    if (!within(cwd, thread.cwd)) return reply.code(400).send({ error: "当前会话不在工作流项目目录中" });
    const { task, token } = store.create("thread:" + threadId, { title: thread.name ?? thread.preview?.slice(0, 120) ?? "EaseCation 工作", kind: "improvement", prompt: thread.preview ?? "", cwd: thread.cwd });
    store.update(task.id, { threadId, status: "running", runtime: thread.status?.type ?? "unknown" }, "attached");
    const context = { workflowId: task.id, endpoint, token };
    await fs.mkdir(path.join(directory, "contexts"), { recursive: true });
    await fs.writeFile(path.join(directory, "contexts", task.id + ".json"), JSON.stringify(context), { mode: 0o600 });
    return context;
  });
  app.get<{ Params: { id: string } }>(prefix + "/:id", async (request, reply) => {
    const task = store.get(request.params.id);
    return task ? { ...task, events: store.events(task.id) } : reply.code(404).send({ error: "工作流不存在" });
  });
  app.post(prefix, { preHandler: sameOrigin, schema: { body: { type: "object", additionalProperties: false,
    required: ["requestKey", "title", "kind", "prompt"], properties: {
      requestKey: { type: "string", format: "uuid" }, title: { type: "string", minLength: 1, maxLength: 200 },
      kind: { type: "string", enum: kinds }, prompt: { type: "string", minLength: 1, maxLength: 32000 },
      issueNumber: { type: "integer", minimum: 1, maximum: 100000000 },
    } } } }, async (request, reply) => {
    const input = request.body as any;
    const existing = store.byKey(input.requestKey) ?? (input.issueNumber ? inbox.associated(input.issueNumber) : undefined);
    if (existing) return existing;
    try { workflowManager(); } catch (error) { return reply.code(503).send({ error: (error as Error).message }); }
    if (!input.title.trim() || !input.prompt.trim()) return reply.code(400).send({ error: "请填写标题和工作内容" });
    let issue;
    if (input.issueNumber) {
      try { issue = await inbox.findAssigned(input.issueNumber); }
      catch (error) { return reply.code(503).send({ error: (error as Error).message }); }
      if (!issue) return reply.code(409).send({ error: "该事项已完成或已不由你负责，请重新同步" });
      const associated = inbox.associated(issue.number);
      if (associated) return associated;
    }
    const key = issue ? "issue:" + issue.number : input.requestKey;
    const duplicate = store.byKey(key);
    if (duplicate) return duplicate;
    let title = input.title.trim();
    if (issue) {
      try { title = workflowIssueTitle(issue.number, title); }
      catch (error) { return reply.code(400).send({ error: (error as Error).message }); }
    }
    const created = store.create(key, { title, kind: input.kind,
      prompt: issue ? `${input.prompt.trim()}\n\n对应 Möbius 事项：${issue.url}（#${issue.number}）。读取原事项需求并复用该事项，先核对已有工作与交付。` : input.prompt.trim(), cwd });
    const token = created.token;
    const task = issue ? store.update(created.task.id, { issue, project: issue.project ?? "", workflowSource: "workflow",
      mobius: { status: issue.status, desired: null, checkedAt: new Date().toISOString(), error: null } }, "issue.linked") : created.task;
    void (async () => {
      const contextFile = path.join(directory, "contexts", task.id + ".json");
      await fs.mkdir(path.dirname(contextFile), { recursive: true });
      await fs.writeFile(contextFile, JSON.stringify({ workflowId: task.id, endpoint, token }), { mode: 0o600 });
      const prompt = `${task.prompt}\n\n使用 $easecation-workflow 推进这项${({ feature: "新功能", fix: "问题修复", improvement: "改进", research: "调研" } as any)[task.kind]}工作。工作流编号：${task.id}。进度上报上下文文件：${contextFile}。使用 Skill 中的 report-progress.py 更新实际阶段、摘要、阻塞和证据。上下文内的令牌不得写入 Git、文档或回复。`;
      try {
        await createWorkflowThread(task, prompt, threadId => store.update(task.id, { threadId }, "thread.created"));
        store.update(task.id, { status: "running", runtime: "active" }, "started");
      } catch (error) {
        store.update(task.id, { status: "blocked", runtime: "unknown", error: (error as Error).message }, "start.failed");
      }
    })().catch(error => store.update(task.id, { status: "blocked", error: String(error) }, "start.failed"));
    return reply.code(202).send(task);
  });
  app.post<{ Params: { id: string } }>(prefix + "/:id/report", { schema: { body: {
    type: "object", additionalProperties: false, minProperties: 1, properties: reportProperties,
  } } }, async (request, reply) => {
    const id = request.params.id;
    if (!store.validToken(id, request.headers.authorization?.replace(/^Bearer /, "") ?? "")) return reply.code(403).send({ error: "工作流上报凭据无效" });
    if (lifecycle.isBusy(id)) return reply.code(409).send({ error: "正在核对交付与资源，请稍后上报" });
    const report = request.body as any;
    if ((report.status === "completed" || report.stage === "done") && !report.summary?.trim()) return reply.code(400).send({ error: "完成时请填写结果摘要" });
    const previous = store.get(id)!;
    if (previous.archivedAt || previous.cleanup.state === "released" && (report.worktrees || report.remoteWorktrees || report.resources || report.deliveries)) return reply.code(409).send({ error: "资源已收尾，请在新事项中登记后续工作" });
    if (report.worktrees?.some((worktree: any) => !within(cwd, worktree.path) || !within(cwd, worktree.repo))) return reply.code(400).send({ error: "工作区须位于工作流项目目录内" });
    const localWorktrees = report.worktrees ?? previous.worktrees;
    if (localWorktrees.length) {
      try { report.worktrees = await Promise.all(localWorktrees.map((worktree: any) =>
        worktree.releasedAt || worktree.removalStartedAt ? worktree : inspectRegisteredWorktree(worktree, cwd))); }
      catch { return reply.code(409).send({ error: "本机工作区登记未确认，保留原登记" }); }
    }
    if (report.remoteWorktrees || report.resources?.some((resource: any) => resource.kind === "bbdev-lease")) {
      try {
        report.remoteWorktrees = await inspectRemoteWorktrees(report.remoteWorktrees ?? previous.remoteWorktrees ?? [], report.resources ?? previous.resources);
        report.remoteWorktreesSync = { checkedAt: new Date().toISOString(), error: null };
      } catch { return reply.code(503).send({ error: "远端工作区登记未确认，保留原登记" }); }
    }
    if (report.issue) {
      if (previous.issue?.number === report.issue.number) report.issue = { ...previous.issue, ...report.issue };
      const base = process.env.CODEX_WORKFLOW_ISSUE_URL;
      if (!base) return reply.code(503).send({ error: "事项入口尚未配置" });
      const url = new URL(base); url.searchParams.set("issue", String(report.issue.number));
      report.issue.url = url.href;
    }
    if (report.title) {
      const number = report.issue?.number ?? previous.issue?.number;
      try { report.title = number ? workflowIssueTitle(number, report.title) : report.title.trim(); }
      catch (error) { return reply.code(400).send({ error: (error as Error).message }); }
      if (!report.title) return reply.code(400).send({ error: "请填写事项总结作为标题" });
      if (previous.threadId) {
        try {
          const client = workflowHost().getLocalAppServerClient();
          await client.sendAppServerRequest("thread/name/set", { threadId: previous.threadId, name: report.title });
          const observed = await client.readThread(previous.threadId, { includeTurns: false });
          if (observed.name !== report.title) throw Error("会话标题未确认");
        } catch { return reply.code(503).send({ error: "会话标题更新未确认，请稍后重试" }); }
      }
    }
    if (report.deliveries) report.deliveries = report.deliveries.map((d: any) => ({ ...d, url: `https://github.com/${d.repo}/pull/${d.pr}` }));
    if (report.resources) report.resources = report.resources.map((resource: any) => ({ ...resource, released: false }));
    const updated = store.update(id, { ...report, managed: true }, "progress");
    void lifecycle.reconcile(id).catch(error => app.log.error(error));
    return updated;
  });
  app.post(prefix + "/refresh", { preHandler: sameOrigin }, async (_request, reply) => {
    refreshAll(true);
    return reply.code(202).send({ syncing: true });
  });
  app.post<{ Params: { id: string } }>(prefix + "/:id/release",
    { preHandler: sameOrigin }, async (request, reply) => {
      if (!store.get(request.params.id)) return reply.code(404).send({ error: "工作流不存在" });
      return lifecycle.reconcile(request.params.id);
    });
  app.post<{ Params: { id: string } }>(prefix + "/:id/archive", { preHandler: sameOrigin }, async (request, reply) => {
    if (!store.get(request.params.id)) return reply.code(404).send({ error: "工作流不存在" });
    try { return await lifecycle.archiveAndClean(request.params.id); }
    catch (error) { return reply.code(409).send({ error: (error as Error).message }); }
  });
  let ticks = 0;
  const timer = setInterval(async () => {
    if (polling) return;
    polling = true;
    try {
      const connection = workflowHost()?.getLocalAppServerClient();
      if (connection && connection !== notificationConnection) {
        unsubscribe?.(); notificationConnection = connection;
        unsubscribe = connection.registerInternalNotificationHandler((message: any) => {
          if (message.method !== "turn/plan/updated") return;
          const task = store.list().find(task => task.threadId === message.params?.threadId);
          if (task) store.update(task.id, { plan: message.params.plan }, "plan.updated");
        });
      }
      const tasks = store.list().filter(task => task.threadId && !task.archivedAt);
      try {
        const snapshots = await workflowSnapshots(tasks.map(task => task.threadId!));
        for (const task of tasks) {
          const snapshot = snapshots.get(task.threadId!)!;
          store.update(task.id, { ...snapshot,
            ...(snapshot.runtime !== "unknown" ? { runtimeLastKnown: { runtime: snapshot.runtime, activeFlags: snapshot.activeFlags, pending: snapshot.pending, checkedAt: snapshot.runtimeCheckedAt } } : {}),
            updatedAt: store.get(task.id)!.updatedAt });
        }
      } catch {
        for (const task of tasks) store.update(task.id, { runtime: "unknown", activeFlags: [], pending: 0, runtimeCheckedAt: new Date().toISOString(), updatedAt: store.get(task.id)!.updatedAt });
      }
      if (++ticks % 15 === 0) {
        refreshAll();
      } else if (ticks % 3 === 0 && !checkingWorktrees) {
        checkingWorktrees = Promise.allSettled(tasks.map(task => refreshRemoteWorktrees(store, task.id)))
          .finally(() => { checkingWorktrees = undefined; });
      }
    } finally { polling = false; }
  }, 10000);
  await syncThreads();
  timer.unref();
  refreshAll(true);
  app.addHook("onClose", async () => { clearInterval(timer); unsubscribe?.(); await refreshing; await checkingWorktrees; await indexing; await lifecycle.drain(); closeRuntimeObservers(); store.close(); });
}
