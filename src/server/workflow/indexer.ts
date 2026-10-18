import fs from "node:fs/promises";
import path from "node:path";
import type { WorkflowStore } from "./store";
const Database = require("better-sqlite3");

export function within(root: string, target: string) {
  const relative = path.relative(path.resolve(root), path.resolve(target.replace(/^\\\\\?\\/, "")));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
export function issueFrom(text: string) {
  const base = process.env.CODEX_WORKFLOW_ISSUE_URL;
  if (!base) return null;
  const url = text.match(/https:\/\/[^\s<>"'）)]+/g)?.find(url => {
    try { return new URL(url).origin === new URL(base).origin && /(?:issue[=/]|issues\/)(\d+)/.test(url); } catch { return false; }
  });
  const number = url?.match(/(?:issue[=/]|issues\/)(\d+)/)?.[1] ?? text.match(/(?:莫比乌斯|Möbius|Mobius)\s*(?:事项)?\s*[#＃]?\s*(\d{1,8})/i)?.[1];
  if (!number) return null;
  const link = new URL(base); link.searchParams.set("issue", number);
  return { number: Number(number), url: url ?? link.href };
}
export async function importProjectThreads(store: WorkflowStore, cwd: string, directory: string) {
  const file = path.join(process.env.CODEX_HOME!, "state_5.sqlite");
  try { await fs.access(file); } catch { return; }
  const db = new Database(file, { readonly: true, fileMustExist: true });
  let rows: any[];
  try { rows = db.prepare("SELECT id,name,title,preview,first_user_message,cwd,source,updated_at,project_id FROM threads WHERE archived=0 AND first_user_message<>'' ORDER BY updated_at DESC LIMIT 1000").all(); }
  finally { db.close(); }
  const existing = new Set(store.list().map(task => task.threadId));
  for (const row of rows) {
    if (!within(cwd, row.cwd) || row.source.includes("subagent") || existing.has(row.id)) continue;
    const title = (row.name || row.title || "EaseCation 工作").slice(0, 200);
    const prompt = row.first_user_message;
    const { task, token } = store.create("thread:" + row.id, { title, prompt: prompt.slice(0, 32000), kind: "improvement", cwd: row.cwd });
    const issue = issueFrom(prompt + "\n" + title);
    store.update(task.id, { threadId: row.id, issue, project: row.cwd === cwd ? "EaseCation" : path.basename(row.cwd),
      imported: true, status: "waiting", runtime: "unknown", summary: row.preview?.slice(0, 1000) || "",
      updatedAt: new Date(row.updated_at * 1000).toISOString() }, "imported");
    await fs.mkdir(path.join(directory, "contexts"), { recursive: true });
    await fs.writeFile(path.join(directory, "contexts", task.id + ".json"), JSON.stringify({ workflowId: task.id,
      endpoint: process.env.CODEX_WORKFLOW_LOCAL_URL + "/__backend/workflow", token }), { mode: 0o600 });
  }
}
