import { command } from "./git";
import type { WorkflowStore } from "./store";

export type InboxIssue = {
  number: number; title: string; url: string; status: string; project: string | null;
  ancestors: { number: number; title: string; url: string }[];
};

export class WorkflowInbox {
  private items: InboxIssue[] = [];
  private checkedAt: string | null = null;
  private error: string | null = null;
  private pending: Promise<void> | undefined;
  private attemptedAt = 0;
  constructor(private store: WorkflowStore) {}

  associated(number: number) {
    return this.store.list().find(task => task.issue?.number === number ||
      task.relatedIssues?.some(issue => issue.number === number));
  }

  snapshot() {
    return { items: this.items.filter(issue => !this.associated(issue.number)), checkedAt: this.checkedAt, error: this.error };
  }

  async refresh(force = false) {
    if (this.pending) return this.pending;
    if (!force && Date.now() - this.attemptedAt < 150000) return;
    this.attemptedAt = Date.now();
    this.pending = (async () => {
      try {
        const helper = process.env.CODEX_WORKFLOW_INBOX_HELPER;
        if (!helper) throw Error("Möbius 收集箱尚未配置");
        const result = JSON.parse(await command(process.env.CODEX_WORKFLOW_PYTHON ?? "python", ["-X", "utf8", helper]));
        if (!Array.isArray(result.items) || result.items.some((item: any) =>
          !Number.isInteger(item.number) || item.number < 1 || !item.title || !item.url || !item.status || !Array.isArray(item.ancestors))) {
          throw Error("Möbius 收集箱数据不完整");
        }
        this.items = result.items;
        this.checkedAt = new Date().toISOString();
        this.error = null;
      } catch {
        this.error = "Möbius 收集箱读取失败，请重新同步";
      }
    })().finally(() => { this.pending = undefined; });
    return this.pending;
  }

  async findAssigned(number: number) {
    await this.refresh(true);
    if (this.error) throw Error(this.error);
    return this.items.find(issue => issue.number === number);
  }
}
