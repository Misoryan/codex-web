import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import type { Delivery, Worktree } from "./store";
import { within } from "./indexer";
import { containsReleasePatch } from "./release-proof";
const execute = promisify(execFile);
export async function command(executable: string, args: string[], cwd?: string) {
 const {stdout}=await execute(executable,args,{cwd,timeout:45000,windowsHide:true,maxBuffer:4*1024*1024,encoding:"utf8"});
 return stdout.trim();
}
export const git=(repo:string,...args:string[])=>command("git",["-C",repo,...args]);
export function githubRepo(remote:string){return remote.match(/(?:github\.com[:/])([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/)?.[1]}
export async function inspectDelivery(delivery:Delivery, releaseHeads = new Map<string, Promise<string>>()):Promise<Delivery>{
 if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(delivery.repo)||!/^\w[\w./-]*$/.test(delivery.release))throw Error("交付仓库或分支无效");
 const pr=JSON.parse(await command("gh",["pr","view",String(delivery.pr),"--repo",delivery.repo,"--json","state,isDraft,baseRefName,headRefOid,mergeCommit,mergedAt,url"]));
 if(!["OPEN","CLOSED","MERGED"].includes(pr.state)||typeof pr.isDraft!=="boolean")throw Error("PR 状态记录不完整");
 const base=delivery.base||pr.baseRefName;
 if(pr.baseRefName!==base||!["dev","main","master"].includes(base))throw Error("PR 的目标分支与登记内容不符");
 const next:Delivery={repo:delivery.repo,pr:delivery.pr,url:pr.url,base,release:delivery.release,issueNumbers:delivery.issueNumbers,head:pr.headRefOid,
   state:pr.state,isDraft:pr.isDraft,checkedAt:new Date().toISOString()};
 if(pr.state!=="MERGED")return next;
 if(!/^[a-f0-9]{40}$/.test(pr.mergeCommit?.oid)||!Number.isFinite(Date.parse(pr.mergedAt)))throw Error("合入记录缺少提交编号或时间");
 const dev=JSON.parse(await command("gh",["api",`repos/${delivery.repo}/compare/${pr.mergeCommit.oid}...${base}`]));
 if(!["ahead","identical"].includes(dev.status))throw Error("合入提交当前不在目标分支中");
 next.merge=pr.mergeCommit.oid;next.devMergedAt=pr.mergedAt;
 {
  try {
   const branchKey=delivery.repo.toLowerCase()+"#"+delivery.release;
   if(!releaseHeads.has(branchKey))releaseHeads.set(branchKey,command("gh",["api",`repos/${delivery.repo}/commits/${delivery.release}`]).then(raw=>JSON.parse(raw).sha));
   const commit=await releaseHeads.get(branchKey)!;
   if(typeof commit!=="string"||!/^[a-f0-9]{40}$/.test(commit))throw Error("发布提交未确认");
   if(delivery.merge===next.merge&&delivery.releaseProof?.commit===commit&&delivery.masterMergedAt){
    next.masterMergedAt=delivery.masterMergedAt;next.releaseProof={...delivery.releaseProof,checkedAt:next.checkedAt!};return next;
   }
   const release=JSON.parse(await command("gh",["api",`repos/${delivery.repo}/compare/${next.merge}...${commit}`]));
   if(!["ahead","behind","identical","diverged"].includes(release.status))throw Error("发布比较结果不完整");
   const method=["ahead","identical"].includes(release.status)?"ancestry":release.status!=="behind"&&await containsReleasePatch(delivery.repo,next.merge!,commit)?"patch":null;
   if(method){next.masterMergedAt=delivery.masterMergedAt??next.checkedAt;next.releaseProof={method,commit,checkedAt:next.checkedAt!};}
  } catch { next.error="发布分支暂时无法核对"; }
 }
 return next;
}
function worktreeEntries(raw:string){
 const entries:any[]=[];let entry:any;
 for(const part of raw.split("\0")){
  if(part.startsWith("worktree ")){entry={path:part.slice(9)};entries.push(entry)}
  else if(part.startsWith("HEAD "))entry.head=part.slice(5);
  else if(part.startsWith("branch "))entry.branch=part.slice(7);
  else if(part.startsWith("locked"))entry.locked=true;
 }
 return entries;
}
export async function inspectRegisteredWorktree(worktree:Worktree,workspace:string):Promise<Worktree>{
 const target=path.resolve(worktree.path),repo=path.resolve(worktree.repo);
 if(!within(workspace,target)||!within(workspace,repo)||target.toLowerCase()===repo.toLowerCase())throw Error("路径不是项目内的独立任务 worktree");
 if((await fs.realpath(target)).toLowerCase()!==target.toLowerCase()||(await fs.realpath(repo)).toLowerCase()!==repo.toLowerCase())throw Error("工作区不能通过符号链接登记");
 const entries=worktreeEntries(await git(repo,"worktree","list","--porcelain","-z"));
 const entry=entries.find(value=>path.resolve(value.path).toLowerCase()===target.toLowerCase());
 if(!entry||entry===entries[0]||path.resolve(entries[0].path).toLowerCase()!==repo.toLowerCase())throw Error("任务 worktree 未登记或主工作区不符");
 const root=await git(target,"rev-parse","--show-toplevel");
 if(path.resolve(root).toLowerCase()!==target.toLowerCase()||!entry.branch?.startsWith("refs/heads/"))throw Error("任务 worktree 根目录或分支不符");
 return {...worktree,repo,path:target,head:entry.head,branch:entry.branch.slice(11)};
}
export async function verifyWorktree(worktree:Worktree,workspace:string,deliveries:Delivery[]){
 const target=path.resolve(worktree.path),repo=path.resolve(worktree.repo);
 if(!within(workspace,target)||!within(workspace,repo)||target.toLowerCase()===path.resolve(workspace).toLowerCase()||target.toLowerCase()===repo.toLowerCase())throw Error("路径不是项目内的独立任务 worktree");
 if(["dev","master","main"].includes(worktree.branch))throw Error("不清理长期分支");
 const remote=githubRepo(await git(repo,"remote","get-url","origin"));
 if(!deliveries.some(d=>d.repo.toLowerCase()===remote?.toLowerCase()&&d.devMergedAt&&d.head===worktree.head))throw Error("工作区提交未与已合入的 PR 对应");
 const entries=worktreeEntries(await git(repo,"worktree","list","--porcelain","-z"));
 const entry=entries.find(e=>path.resolve(e.path).toLowerCase()===target.toLowerCase());
 const exists=await fs.stat(target).then(()=>true,error=>{if(error.code==="ENOENT")return false;throw error});
 if(!exists){if(!worktree.removalStartedAt||entry)throw Error("工作区路径已改变，须重新登记");return {target,repo,exists}}
 if(!entry||entry===entries[0]||entry.locked)throw Error("任务 worktree 未登记、属于主工作区或已锁定");
 if((await fs.realpath(target)).toLowerCase()!==target.toLowerCase())throw Error("任务 worktree 不能通过符号链接清理");
 if(entry.head!==worktree.head||entry.branch!=="refs/heads/"+worktree.branch)throw Error("工作区提交或分支已改变，须重新登记");
 const dirty=await git(target,"status","--porcelain=v1","--untracked-files=all","--ignored=matching","--ignore-submodules=none");
 if(dirty)throw Error("工作区有未提交、未跟踪或被忽略的文件："+dirty.split("\n")[0]);
 const subDirty=await git(target,"submodule","foreach","--quiet","--recursive","git status --porcelain=v1 --untracked-files=all --ignored=matching");
 if(subDirty)throw Error("子模块有未提交、未跟踪或被忽略的文件");
 return {target,repo,exists};
}
export async function removeWorktree(worktree:Worktree,workspace:string,deliveries:Delivery[],save:(value:Worktree)=>void,beforeRemove?:()=>Promise<void>){
 const verified=await verifyWorktree(worktree,workspace,deliveries);
 let next={...worktree};
 if(verified.exists){
  next.removalStartedAt=new Date().toISOString();save(next);
  const submodules=await git(verified.target,"submodule","status","--recursive");
  await beforeRemove?.();
  await verifyWorktree(worktree,workspace,deliveries);
  await git(verified.repo,"worktree","remove",...(submodules?["--force"]:[]),verified.target);
 }
 const remains=await fs.stat(verified.target).then(()=>true,error=>{if(error.code==="ENOENT")return false;throw error});
 if(remains)throw Error("Git 执行后工作区仍存在");
 next.removedAt=new Date().toISOString();save(next);
 const refs=await git(verified.repo,"for-each-ref","--format=%(objectname)","refs/heads/"+worktree.branch);
 if(refs){if(refs!==worktree.head)throw Error("任务分支提交已改变，已保留分支");await git(verified.repo,"branch","-D",worktree.branch)}
 if(await git(verified.repo,"for-each-ref","--format=%(refname)","refs/heads/"+worktree.branch))throw Error("任务分支仍存在");
 next.releasedAt=new Date().toISOString();save(next);return next;
}
