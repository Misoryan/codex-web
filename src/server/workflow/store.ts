import fs from "node:fs";
import path from "node:path";
import { randomUUID, randomBytes, createHash } from "node:crypto";

const Database = require("better-sqlite3");
export type Delivery = { repo: string; pr: number; url: string; base: string; release: string;
  head?: string; merge?: string; devMergedAt?: string; masterMergedAt?: string; error?: string };
export type Worktree = { repo: string; path: string; branch: string; head: string;
  removalStartedAt?: string; removedAt?: string; releasedAt?: string };
export type Resource = { kind: "bbdev-lease" | "bedrock-client"; task: string; lease: string; slot?: number; released: boolean };
export type RemoteWorktree = { host: "bbdev"; task: string; path: string; branch: string; head: string;
  cleanup: { state: string; reason: string; checkedAt: string | null } };
export type Workflow = {
  id: string; title: string; kind: string; prompt: string; cwd: string;
  threadId: string | null; stage: string; status: string; summary: string;
  evidence: { label: string; value: string; url?: string }[];
  plan: { step: string; status: string }[]; runtime: string; activeFlags?: string[]; runtimeCheckedAt?: string;
  lastMessage: string; pending: number; error: string | null;
  createdAt: string; updatedAt: string;
  issue: { number: number; url: string; title?: string; status?: string; ancestors?: { number: number; title: string; url: string }[] } | null; project: string;
  relatedIssues?: { number: number; title?: string; url: string; status?: string }[];
  workflowSource?: "issue-fix" | "workflow";
  deliveries: Delivery[]; worktrees: Worktree[]; resources: Resource[];
  remoteWorktrees?: RemoteWorktree[]; remoteWorktreesSync?: { checkedAt: string; error: string | null };
  cleanup: { state: "none" | "pending" | "blocked" | "released"; reason: string; checkedAt?: string; releasedAt?: string };
  archivedAt: string | null; imported: boolean;
  managed: boolean; projectsRemoved: string[];
  mobius: { status: string | null; desired: string | null; checkedAt: string | null; error: string | null };
};
export class WorkflowStore {
  db: any;
  constructor(directory: string) {
    fs.mkdirSync(directory, { recursive: true });
    this.db = new Database(path.join(directory, "workflow.sqlite"));
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`CREATE TABLE IF NOT EXISTS workflows (
      id TEXT PRIMARY KEY, request_key TEXT NOT NULL UNIQUE, token_hash TEXT NOT NULL,
      data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, workflow_id TEXT NOT NULL, time TEXT NOT NULL,
      kind TEXT NOT NULL, data TEXT NOT NULL)`);
  }
  list(): Workflow[] {
    return this.db.prepare("SELECT data FROM workflows ORDER BY rowid DESC").all()
      .map((row: any) => JSON.parse(row.data))
      .sort((a: Workflow, b: Workflow) => b.updatedAt.localeCompare(a.updatedAt));
  }
  get(id: string): Workflow | undefined {
    const row = this.db.prepare("SELECT data FROM workflows WHERE id=?").get(id);
    return row && JSON.parse(row.data);
  }
  byKey(key: string): Workflow | undefined {
    const row = this.db.prepare("SELECT data FROM workflows WHERE request_key=?").get(key);
    return row && JSON.parse(row.data);
  }
  create(key: string, input: Pick<Workflow, "title" | "kind" | "prompt" | "cwd">) {
    const token = randomBytes(32).toString("hex");
    const now = new Date().toISOString();
    const task: Workflow = { ...input, id: randomUUID(), threadId: null, stage: "intake",
      status: "starting", summary: "", evidence: [], plan: [], runtime: "starting",
      lastMessage: "", pending: 0, error: null, createdAt: now, updatedAt: now,
      issue: null, project: "EaseCation", deliveries: [], worktrees: [], resources: [],
      cleanup: { state: "none", reason: "" }, archivedAt: null, imported: false,
      managed: false, projectsRemoved: [], mobius: { status: null, desired: null, checkedAt: null, error: null } };
    this.db.prepare("INSERT INTO workflows VALUES (?,?,?,?)")
      .run(task.id, key, createHash("sha256").update(token).digest("hex"), JSON.stringify(task));
    this.event(task.id, "created", { title: task.title });
    return { task, token };
  }
  validToken(id: string, token: string) {
    const row = this.db.prepare("SELECT token_hash FROM workflows WHERE id=?").get(id);
    return Boolean(row && token && row.token_hash === createHash("sha256").update(token).digest("hex"));
  }
  update(id: string, patch: Partial<Workflow>, event?: string) {
    const previous = this.get(id);
    if (!previous) throw Error("工作流不存在");
    const next = { ...previous, ...patch };
    if (JSON.stringify(next) === JSON.stringify(previous)) return previous;
    next.updatedAt = patch.updatedAt ?? new Date().toISOString();
    this.db.prepare("UPDATE workflows SET data=? WHERE id=?").run(JSON.stringify(next), id);
    if (event) this.event(id, event, patch);
    return next;
  }
  event(id: string, kind: string, data: unknown) {
    this.db.prepare("INSERT INTO events (workflow_id,time,kind,data) VALUES (?,?,?,?)")
      .run(id, new Date().toISOString(), kind, JSON.stringify(data));
  }
  events(id: string) {
    return this.db.prepare("SELECT seq,time,kind,data FROM events WHERE workflow_id=? ORDER BY seq DESC LIMIT 100")
      .all(id).map((row: any) => ({ ...row, data: JSON.parse(row.data) }));
  }
  close() { this.db.close(); }
}
