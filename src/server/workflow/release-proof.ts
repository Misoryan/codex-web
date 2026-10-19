import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

const execute = promisify(execFile);
const locks = new Map<string, Promise<boolean>>();

// Git checks the complete merged patch against an isolated release index.
export function containsReleasePatch(repo: string, merge: string, release: string): Promise<boolean> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || ![merge, release].every(sha => /^[a-f0-9]{40}$/.test(sha))) throw Error("发布提交无效");
  const directory = process.env.CODEX_WORKFLOW_DATA ?? path.join(process.env.CODEX_HOME!, "workflow");
  const cache = path.join(directory, "release-objects", createHash("sha256").update(repo.toLowerCase()).digest("hex"));
  const previous = locks.get(cache) ?? Promise.resolve(false);
  const operation = previous.catch(() => false).then(async () => {
    await fs.mkdir(cache, { recursive: true });
    const git = async (...args: string[]) => (await execute("git", ["-C", cache,
      "-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential", ...args],
      { windowsHide: true, timeout: 45000, maxBuffer: 32 * 1024 * 1024, encoding: "utf8" })).stdout;
    try { await fs.access(path.join(cache, "HEAD")); }
    catch {
      await git("init", "--bare");
      await git("remote", "add", "origin", `https://github.com/${repo}.git`);
      await git("config", "remote.origin.promisor", "true");
      await git("config", "remote.origin.partialclonefilter", "blob:none");
    }
    await git("fetch", "--no-tags", "--filter=blob:none", "--depth=2", "origin", merge, release);
    const patch = await git("diff", "--binary", "--full-index", "--no-ext-diff", `${merge}^1`, merge);
    if (!patch.trim()) return false;
    const temporary = await fs.mkdtemp(path.join(directory, "release-index-"));
    const index = path.join(temporary, "index"), patchFile = path.join(temporary, "change.patch");
    try {
      await fs.writeFile(patchFile, patch);
      const options = { windowsHide: true, timeout: 45000, maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, GIT_INDEX_FILE: index } };
      const prefix = ["-C", cache, "-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"];
      await execute("git", [...prefix, "read-tree", release], options);
      try {
        await execute("git", [...prefix, "apply", "--reverse", "--check", "--cached", "--binary", patchFile], options);
        return true;
      } catch (error) {
        if ((error as any).code === 1) return false;
        throw error;
      }
    } finally {
      // Only files created by this invocation are removed; Git worktrees are untouched.
      for (const file of [index, index + ".lock", patchFile]) await fs.unlink(file).catch(error => { if (error.code !== "ENOENT") throw error; });
      await fs.rmdir(temporary);
    }
  });
  locks.set(cache, operation);
  void operation.finally(() => { if (locks.get(cache) === operation) locks.delete(cache); }).catch(() => {});
  return operation;
}
