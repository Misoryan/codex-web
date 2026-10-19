import { command, githubRepo, inspectDelivery } from "./git";
import type { Delivery, Workflow, WorkflowStore } from "./store";

export const tracksPublication = (task: Workflow) => task.managed || task.workflowSource === "workflow" || task.workflowSource === "issue-fix";
const numbers = (task: Workflow) => [...new Set([task.issue?.number, ...(task.relatedIssues?.map(issue => issue.number) ?? [])].filter((value): value is number => value !== undefined))];
const fingerprint = (task: Workflow) => JSON.stringify([task.issue, task.relatedIssues?.map(issue => issue.number), task.deliveries, task.worktrees, task.remoteWorktrees, task.stage, task.status]);
const key = (delivery: Pick<Delivery, "repo" | "pr">) => delivery.repo.toLowerCase() + "#" + delivery.pr;
type Issue = { number: number; title: string; status: string; isLeaf: boolean; pullRequests: string[] };
const statuses = ["TRIAGE", "PLANNED", "IN_PROGRESS", "BLOCKED", "READY_FOR_TEST", "READY_FOR_RELEASE", "DONE"];

export class PublicationMonitor {
  private pending?: Promise<void>;
  private attemptedAt = 0;
  private busy = new Map<string, number>();
  constructor(private store: WorkflowStore) {}
  isBusy(id: string) { return this.busy.has(id); }
  invalidate() { this.attemptedAt = 0; }
  async refresh(force = false) {
    if (this.pending) { await this.pending; if (!force && this.attemptedAt) return; }
    if (!force && Date.now() - this.attemptedAt < 150000) return;
    this.attemptedAt = Date.now();
    this.pending = this.scan().finally(() => { this.pending = undefined; this.busy.clear(); });
    return this.pending;
  }
  private async scan() {
    const helper = process.env.CODEX_WORKFLOW_MOBIUS_HELPER;
    if (!helper) {
      for (const task of this.store.list().filter(tracksPublication)) this.store.update(task.id, { publication: { checkedAt: new Date().toISOString(), error: "Möbius 同步服务未配置", issues: [] } }, "delivery.checked");
      return;
    }
    const tasks = this.store.list().filter(tracksPublication);
    const issues = new Map<number, Issue>(), failures = new Map<number, string>();
    const prs = new Map<string, Promise<Delivery>>();
    const releaseHeads = new Map<string, Promise<string>>(), defaults = new Map<string, Promise<string>>();
    const freshReleaseHeads = new Map<string, Promise<string>>();
    const run = async <T>(items: T[], action: (item: T) => Promise<void>) => {
      let offset = 0;
      await Promise.all(Array.from({ length: 3 }, async () => { while (offset < items.length) await action(items[offset++]!); }));
    };
    await run([...new Set(tasks.flatMap(numbers))], async number => {
      try {
        const result = JSON.parse(await command(process.env.CODEX_WORKFLOW_PYTHON ?? "python", ["-X", "utf8", helper, "--number", String(number), "--inspect"]));
        if (result.number !== number || !statuses.includes(result.status) || typeof result.isLeaf !== "boolean" || !Array.isArray(result.pullRequests)) throw Error();
        issues.set(number, result);
      } catch { failures.set(number, "Möbius 事项及 PR 关联暂时无法核对"); }
    });
    const resolve = (reference: Pick<Delivery, "repo" | "pr">, registered?: Delivery) => {
      const id = key(reference);
      if (!prs.has(id)) prs.set(id, (async () => {
        let release = registered?.release;
        if (!release) {
          const repo = reference.repo.toLowerCase();
          if (!defaults.has(repo)) defaults.set(repo, repo.endsWith("/codefuncore") ? Promise.resolve("master")
            : command("gh", ["repo", "view", reference.repo, "--json", "defaultBranchRef"]).then(raw => JSON.parse(raw).defaultBranchRef?.name));
          release = await defaults.get(repo)!;
        }
        if (!["master", "main"].includes(release!)) throw Error("发布分支尚未确认");
        return inspectDelivery({ ...registered, ...reference, base: registered?.base || "", release: release!, url: registered?.url ?? "" }, releaseHeads);
      })());
      return prs.get(id)!;
    };
    const checkedAt = new Date().toISOString();
    const snapshots = new Map<string, string>();
    await run(tasks, async original => {
      const references = new Map<string, Delivery>();
      const add = (delivery: Delivery, issueNumbers: number[]) => {
        const previous = references.get(key(delivery));
        references.set(key(delivery), { ...delivery, issueNumbers: [...new Set([...(previous?.issueNumbers ?? []), ...issueNumbers])].sort((a, b) => a - b) });
      };
      for (const delivery of original.deliveries) add(delivery, delivery.issueNumbers ?? (original.issue ? [original.issue.number] : []));
      for (const number of numbers(original)) for (const url of (issues.get(number)?.isLeaf || number === original.issue?.number ? issues.get(number)?.pullRequests : []) ?? []) {
        const match = typeof url === "string" && url.match(/^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/([1-9]\d*)\/?$/);
        if (!match) { failures.set(number, "事项的 PR 关联格式无效"); continue; }
        const repo = match[1]!, pr = Number(match[2]);
        add({ repo, pr, url, base: "", release: "" }, [number]);
      }
      let error = numbers(original).map(number => failures.get(number)).find(Boolean) ?? null;
      const branches = [
        ...original.worktrees.filter(tree => !tree.releasedAt).map(tree => ({ local: tree.repo, origin: "", branch: tree.branch })),
        ...(original.remoteWorktrees ?? []).filter(tree => tree.cleanup.state !== "cleaned" && tree.branch).map(tree => ({ local: "", origin: tree.origin ?? "", branch: tree.branch })),
      ];
      for (const branch of branches) {
        try {
          const repo = githubRepo(branch.origin || (branch.local ? await command("git", ["-C", branch.local, "remote", "get-url", "origin"]) : ""));
          if (!repo) throw Error();
          const found = JSON.parse(await command("gh", ["pr", "list", "--repo", repo, "--head", branch.branch, "--state", "all", "--limit", "100", "--json", "number,url,headRefName"]));
          if (found.length >= 100) throw Error("任务分支的 PR 超出核对范围");
          for (const pr of found) if (pr.headRefName === branch.branch) {
            const existing = references.get(key({repo, pr: pr.number}));
            if (!existing && numbers(original).length > 1) { error = "任务分支有尚未分配到具体事项的 PR"; continue; }
            if (!existing) add({ repo, pr: pr.number, url: pr.url, base: "", release: "" }, numbers(original));
          }
        } catch { error = "任务分支的 PR 暂时无法核对"; }
      }
      const deliveries: Delivery[] = [];
      for (const reference of references.values()) {
        try { deliveries.push({ ...await resolve(reference, original.deliveries.find(delivery => key(delivery) === key(reference))), issueNumbers: reference.issueNumbers }); }
        catch { deliveries.push({ repo: reference.repo, pr: reference.pr, url: reference.url, base: reference.base, release: reference.release, issueNumbers: reference.issueNumbers, checkedAt, error: "GitHub 交付记录暂时无法核对" }); }
      }
      const current = this.store.get(original.id)!;
      if (fingerprint(current) !== fingerprint(original)) {
        this.store.update(original.id, { publication: { checkedAt, error: "核对期间交付登记已更新，等待重新核对", issues: [] } }, "delivery.checked");
        return;
      }
      const saved = this.store.update(original.id, { deliveries, publication: { checkedAt, error, issues: original.publication?.issues ?? [] } }, "delivery.checked");
      snapshots.set(original.id, fingerprint(saved));
    });
    const updated = this.store.list().filter(tracksPublication);
    const progress = new Map<number, { number: number; isLeaf: boolean; status: string; desired: string | null; error: string | null }>();
    await run([...issues.values()], async issue => {
      const owners = updated.filter(task => numbers(task).includes(issue.number));
      const linked = owners.flatMap(task => task.deliveries.filter(delivery => delivery.issueNumbers?.includes(issue.number)));
      const required = [...new Map(linked.map(delivery => [key(delivery), delivery])).values()];
      for (const task of owners) this.busy.set(task.id, (this.busy.get(task.id) ?? 0) + 1);
      let error = owners.map(task => task.publication?.error).find(Boolean) ?? null;
      if (linked.some(delivery => delivery.error)) error = "关联 PR 尚未全部核对成功";
      if (required.some(delivery => delivery.state === "CLOSED")) error = "有关联 PR 关闭后未合并，请核对交付关联";
      if (owners.some(task => snapshots.get(task.id) !== fingerprint(this.store.get(task.id)!))) error = "核对期间交付登记已更新，等待重新核对";
      let desired: string | null = null;
      if (!error && issue.isLeaf && required.length) {
        if (required.every(delivery => delivery.masterMergedAt)) {
          try {
            for (const delivery of required) {
              const branch = delivery.repo.toLowerCase() + "#" + delivery.release;
              if (!freshReleaseHeads.has(branch)) freshReleaseHeads.set(branch, command("gh", ["api", `repos/${delivery.repo}/commits/${delivery.release}`]).then(raw => JSON.parse(raw).sha));
              if (await freshReleaseHeads.get(branch)! !== delivery.releaseProof?.commit) throw Error();
            }
            desired = "DONE";
          } catch { error = "发布分支在核对期间变化或暂时不可读，等待重新核对"; }
        }
        else if (required.every(delivery => delivery.devMergedAt)) desired = "READY_FOR_RELEASE";
        else if (required.some(delivery => delivery.state === "OPEN")) desired = "READY_FOR_TEST";
      }
      if (!error && issue.isLeaf && !required.length) {
        // Non-code work requires an explicit agent completion report.
        if (owners.every(task => task.managed && numbers(task).length === 1 && task.kind === "research" && task.stage === "done" && task.status === "completed")) desired = "DONE";
        else if (owners.some(task => task.managed && ["verification", "delivery"].includes(task.stage))) desired = "READY_FOR_TEST";
        else if (owners.some(task => task.managed && task.status === "blocked")) desired = "BLOCKED";
        else if (owners.some(task => task.managed && task.stage === "implementation")) desired = "IN_PROGRESS";
      }
      if (issue.status === "DONE" && desired !== "DONE") desired = null;
      let status = issue.status;
      if (desired && desired !== status) {
        try {
          const result = JSON.parse(await command(process.env.CODEX_WORKFLOW_PYTHON ?? "python", ["-X", "utf8", helper, "--number", String(issue.number), "--desired", desired, "--expected-status", issue.status, "--expected-prs", JSON.stringify([...new Set(issue.pullRequests)].sort())]));
          if (result.number !== issue.number || result.status !== desired) throw Error();
          status = result.status;
        } catch { error = "Möbius 状态未同步：写入未确认，等待重新核对"; }
      }
      progress.set(issue.number, { number: issue.number, isLeaf: issue.isLeaf, status, desired, error });
      for (const task of owners) { const count = this.busy.get(task.id)! - 1; if (count) this.busy.set(task.id, count); else this.busy.delete(task.id); }
    });
    for (const original of updated) {
      const current = this.store.get(original.id)!;
      if (snapshots.get(current.id) !== fingerprint(current)) continue;
      const states = numbers(current).map(number => progress.get(number) ?? { number, status: current.relatedIssues?.find(issue => issue.number === number)?.status ?? "", desired: null, error: failures.get(number) ?? "事项状态未确认" });
      const primary = states.find(issue => issue.number === current.issue?.number);
      const deliveriesDone = current.deliveries.length > 0 && current.deliveries.every(delivery => delivery.state === "MERGED" && delivery.masterMergedAt && !delivery.error);
      const concrete = states.filter(issue => !("isLeaf" in issue) || issue.isLeaf || issue.number === current.issue?.number);
      const done = (concrete.length > 0 ? concrete.every(issue => issue.status === "DONE" && !issue.error) && (!current.deliveries.length || deliveriesDone) : deliveriesDone) && !current.publication?.error;
      this.store.update(current.id, {
        publication: { checkedAt, error: current.publication?.error ?? null, issues: states },
        ...(primary ? { mobius: { status: primary.status || current.mobius.status, desired: primary.desired, error: primary.error, checkedAt } } : {}),
        ...(current.relatedIssues ? { relatedIssues: current.relatedIssues.map(issue => ({ ...issue, status: states.find(state => state.number === issue.number)?.status || issue.status })) } : {}),
        ...(done ? { stage: "done", status: "completed" } : {}),
      }, "delivery.checked");
    }
  }
}
