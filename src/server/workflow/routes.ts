import type { FastifyInstance, FastifyRequest } from "fastify";
import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { WorkflowStore } from "./store";
import { createWorkflowThread, workflowHost, workflowManager, workflowSnapshot } from "./host";

const prefix = "/__backend/workflow";
const stages = ["intake", "research", "implementation", "verification", "delivery", "done"];
const kinds = ["feature", "fix", "improvement", "research"];
const reportProperties = {
  stage: { type: "string", enum: stages },
  status: { type: "string", enum: ["running", "waiting", "blocked", "completed"] },
  summary: { type: "string", maxLength: 8000 },
  evidence: { type: "array", maxItems: 40, items: { type: "object", additionalProperties: false,
    required: ["label", "value"], properties: { label: { type: "string", maxLength: 200 },
      value: { type: "string", maxLength: 4000 }, url: { type: "string", pattern: "^https://", maxLength: 2000 } } } },
};

export async function registerWorkflow(app: FastifyInstance) {
  const cwd = process.env.CODEX_WORKFLOW_CWD;
  if (!cwd) return;
  const directory = path.resolve(process.env.CODEX_WORKFLOW_DATA ?? path.join(process.env.CODEX_HOME!, "workflow"));
  const store = new WorkflowStore(directory);
  const allowedOrigins = new Set((process.env.CODEX_WORKFLOW_ORIGINS ?? "").split(",").filter(Boolean));
  const locks = new Set<string>();
  let polling = false;
  async function sameOrigin(request: FastifyRequest, reply: any) {
    const origin = request.headers.origin;
    const localOrigin = `http://${request.headers.host}`;
    if (origin && (origin === localOrigin || allowedOrigins.has(origin))) return;
    return reply.code(403).send({ error: "请从工作流页面执行此操作" });
  }
  app.get(prefix + "/health", async () => {
    try { workflowManager(); return { ready: true, cwd }; }
    catch (error) { return { ready: false, cwd, error: (error as Error).message }; }
  });
  app.get(prefix, async () => store.list());
  app.get<{ Params: { id: string } }>(prefix + "/:id", async (request, reply) => {
    const task = store.get(request.params.id);
    return task ? { ...task, events: store.events(task.id) } : reply.code(404).send({ error: "工作流不存在" });
  });
  app.post(prefix, { preHandler: sameOrigin, schema: { body: { type: "object", additionalProperties: false,
    required: ["requestKey", "title", "kind", "prompt"], properties: {
      requestKey: { type: "string", format: "uuid" }, title: { type: "string", minLength: 1, maxLength: 200 },
      kind: { type: "string", enum: kinds }, prompt: { type: "string", minLength: 1, maxLength: 32000 },
    } } } }, async (request, reply) => {
    const input = request.body as any;
    const existing = store.byKey(input.requestKey);
    if (existing) return existing;
    try { workflowManager(); } catch (error) { return reply.code(503).send({ error: (error as Error).message }); }
    if (!input.title.trim() || !input.prompt.trim()) return reply.code(400).send({ error: "请填写标题和工作内容" });
    const { task, token } = store.create(input.requestKey, { title: input.title.trim(), kind: input.kind, prompt: input.prompt.trim(), cwd });
    void (async () => {
      const contextFile = path.join(directory, "contexts", task.id + ".json");
      await fs.mkdir(path.dirname(contextFile), { recursive: true });
      await fs.writeFile(contextFile, JSON.stringify({ workflowId: task.id, endpoint: process.env.CODEX_WORKFLOW_LOCAL_URL + prefix, token }), { mode: 0o600 });
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
    const report = request.body as any;
    if ((report.status === "completed" || report.stage === "done") && !report.summary?.trim()) return reply.code(400).send({ error: "完成时请填写结果摘要" });
    return store.update(id, report, "progress");
  });
  app.post<{ Params: { id: string } }>(prefix + "/:id/message", { preHandler: sameOrigin,
    schema: { body: { type: "object", additionalProperties: false, required: ["text"], properties: { text: { type: "string", minLength: 1, maxLength: 32000 } } } },
  }, async (request, reply) => {
    const id = request.params.id, task = store.get(id);
    if (!task?.threadId) return reply.code(409).send({ error: "会话尚未创建" });
    if (locks.has(id)) return reply.code(409).send({ error: "消息正在发送" });
    locks.add(id);
    try {
      await workflowManager().sendFollowUpMessage(task.threadId, { prompt: (request.body as any).text });
      store.update(id, { status: "running", error: null }, "message.sent");
      return { ok: true };
    } catch (error) { return reply.code(409).send({ error: (error as Error).message }); }
    finally { locks.delete(id); }
  });
  app.post<{ Params: { id: string } }>(prefix + "/:id/stop", { preHandler: sameOrigin }, async (request, reply) => {
    const task = store.get(request.params.id);
    if (!task?.threadId) return reply.code(409).send({ error: "会话尚未创建" });
    await workflowManager().interruptConversation(task.threadId, "user-stop");
    return store.update(task.id, { status: "waiting" }, "stopped");
  });
  const timer = setInterval(async () => {
    if (polling) return;
    polling = true;
    try {
      for (const task of store.list().filter(task => task.threadId)) {
        try {
          const snapshot = await workflowSnapshot(task.threadId!);
          store.update(task.id, snapshot);
        } catch { /* Native host reconnects without resuming unrelated chats. */ }
      }
    } finally { polling = false; }
  }, 2000);
  timer.unref();
  app.addHook("onClose", async () => { clearInterval(timer); store.close(); });
}
