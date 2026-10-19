const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const cp = require('node:child_process');
const {promisify} = require('node:util');
const ts = require('typescript');
const saved = {...process.env};
const parent = path.resolve('runtime/tmp');
fs.mkdirSync(parent, {recursive:true});
const root = fs.mkdtempSync(path.join(parent, 'publication-'));
const git = (repo,...args) => cp.execFileSync('git',['-C',repo,...args],{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']}).trim();
const repos = new Map(), prs = new Map(), branchPrs = new Map();
let apiFailure = false, changeDuringRead;
const calls = [];
const run = promisify(cp.execFile);
const external = (...args) => cp.execFile(...args);
external[promisify.custom] = async (exe,args,options) => {
  if(exe==='git' && args.includes('add') && args.includes('origin')) {
    const copy=[...args], url=copy.at(-1), name=url.match(/github.com\/(.+)\.git$/)?.[1];
    assert(repos.has(name), 'Git fetch must use an isolated fixture');
    copy[copy.length-1]=repos.get(name).repo;
    return run(exe,copy,options);
  }
  if(exe!=='gh')return run(exe,args,options);
  calls.push(args);
  if(changeDuringRead){const action=changeDuringRead;changeDuringRead=null;action();}
  if(apiFailure)throw Error('Fixture GitHub unavailable');
  let value;
  if(args[0]==='repo') value={defaultBranchRef:{name:'master'}};
  else if(args[0]==='pr'&&args[1]==='list')value=branchPrs.get(args[args.indexOf('--head')+1])||[];
  else if(args[0]==='pr')value=prs.get(args[args.indexOf('--repo')+1]+'#'+args[2]);
  else {
    const match=args[1].match(/^repos\/(.+\/.+)\/(commits|compare)\/(.+)$/);
    assert(match, args.join(' '));
    const fixture=repos.get(match[1]);assert(fixture);
    if(match[2]==='commits')value={sha:git(fixture.repo,'rev-parse',match[3])};
    else {
      const [base,head]=match[3].split('...');
      const ancestor=(a,b)=>cp.spawnSync('git',['-C',fixture.repo,'merge-base','--is-ancestor',a,b],{windowsHide:true}).status===0;
      value={status:base===head?'identical':ancestor(base,head)?'ahead':ancestor(head,base)?'behind':'diverged'};
    }
  }
  assert(value, 'Unregistered external request '+args.join(' '));
  return {stdout:JSON.stringify(value),stderr:''};
};
const cache=new Map();
function load(name){
  const file=path.resolve('src/server/workflow',name+'.ts');
  if(cache.has(file))return cache.get(file).exports;
  const mod=new Module(file,module);mod.filename=file;mod.paths=Module._nodeModulePaths(path.dirname(file));
  const native=mod.require.bind(mod);
  mod.require=id=>id==='node:child_process'?{...cp,execFile:external}:id.startsWith('./')?load(id.slice(2)):native(id);
  cache.set(file,mod);
  mod._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,file);
  return mod.exports;
}
const {WorkflowStore}=load('store'),{PublicationMonitor}=load('publication');
const store=new WorkflowStore(path.join(root,'data'));
process.env.CODEX_WORKFLOW_DATA=path.join(root,'data');
process.env.CODEX_WORKFLOW_MOBIUS_HELPER=path.join(root,'mobius.py');
process.env.PUBLICATION_FIXTURE=path.join(root,'issues');fs.mkdirSync(process.env.PUBLICATION_FIXTURE);
fs.writeFileSync(process.env.CODEX_WORKFLOW_MOBIUS_HELPER,`import argparse,json,os\nfrom pathlib import Path\np=argparse.ArgumentParser()\np.add_argument('--number',type=int,required=True)\np.add_argument('--inspect',action='store_true')\nfor name in ['desired','expected-status','expected-prs']:p.add_argument('--'+name)\na=p.parse_args()\nf=Path(os.environ['PUBLICATION_FIXTURE'])/(str(a.number)+'.json')\ni=json.loads(f.read_text())\nif a.desired:\n assert a.expected_status==i['status']\n assert sorted(set(json.loads(a.expected_prs)))==sorted(set(i['pullRequests']))\n assert i['isLeaf']\n i['status']=a.desired\n f.write_text(json.dumps(i))\nprint(json.dumps(i))\n`);
const monitor=new PublicationMonitor(store);
let serial=0,issues={};
function issue(number,urls=[],patch={}){issues[number]={number,title:'Fixture issue',status:'IN_PROGRESS',isLeaf:true,pullRequests:urls,...patch};saveIssues(number);return {number,url:'https://issues.example.invalid/'+number};}
function saveIssues(number){fs.writeFileSync(path.join(process.env.PUBLICATION_FIXTURE,number+'.json'),JSON.stringify(issues[number]));}
function observed(number){return JSON.parse(fs.readFileSync(path.join(process.env.PUBLICATION_FIXTURE,number+'.json'))).status;}
function task(number,deliveries=[],patch={}){const {task}=store.create('case-'+ ++serial,{title:'Fixture work',kind:'feature',cwd:root,prompt:'Fixture work'});return store.update(task.id,{managed:false,workflowSource:'issue-fix',issue:number?{number,url:'https://issues.example.invalid/'+number}:null,deliveries,...patch});}
function repository(name,mode){
  const repo=path.join(root,'repo-'+ ++serial);fs.mkdirSync(repo);
  git(repo,'init','-b','master');git(repo,'config','user.name','Fixture');git(repo,'config','user.email','fixture@users.noreply.github.com');git(repo,'config','core.autocrlf','false');
  fs.writeFileSync(path.join(repo,'a.txt'),'base\n');fs.writeFileSync(path.join(repo,'old.txt'),'rename me\n');fs.writeFileSync(path.join(repo,'image.bin'),Buffer.from([0,1,2,3]));git(repo,'add','.');git(repo,'commit','-m','Base');
  const base=git(repo,'rev-parse','HEAD');git(repo,'checkout','-b','feature');
  fs.appendFileSync(path.join(repo,'a.txt'),'feature\n');fs.writeFileSync(path.join(repo,'b.txt'),'whole feature\n');git(repo,'mv','old.txt','new.txt');fs.writeFileSync(path.join(repo,'image.bin'),Buffer.from([0,9,8,7]));git(repo,'add','.');git(repo,'commit','-m','Feature');
  const head=git(repo,'rev-parse','HEAD');git(repo,'checkout','-b','dev',base);git(repo,'merge','--no-ff','feature','-m','Merge feature');const merge=git(repo,'rev-parse','HEAD');
  git(repo,'checkout','master');
  if(mode==='merge')git(repo,'merge','--ff-only','dev');
  else if(mode==='cherry'){git(repo,'cherry-pick',head);fs.writeFileSync(path.join(repo,'unrelated.txt'),'unrelated\n');git(repo,'add','.');git(repo,'commit','-m','Unrelated');}
  else if(mode==='squash'){git(repo,'merge','--squash','feature');git(repo,'commit','-m','Squashed release');}
  else if(mode==='partial'){git(repo,'checkout',head,'--','a.txt');git(repo,'commit','-am','Partial release');}
  else if(mode==='reverted'){git(repo,'cherry-pick',head);git(repo,'revert','--no-edit','HEAD');}
  const fixture={repo,base,head,merge};repos.set(name,fixture);return fixture;
}
function pr(repo,number,state='MERGED'){
  const f=repos.get(repo),url=`https://github.com/${repo}/pull/${number}`;
  prs.set(repo+'#'+number,{url,state,isDraft:false,baseRefName:'dev',headRefOid:f.head,mergeCommit:state==='MERGED'?{oid:f.merge}:null,mergedAt:'2026-01-02T03:04:05Z'});
  return {repo,pr:number,url,base:'dev',release:'master'};
}
async function scan(){await monitor.refresh(true);}
async function scenario(name,action){await action();console.log('PASS:',name);}
(async()=>{
  await scenario('真实 Git：merge、cherry-pick、squash 的完整文本、重命名和二进制补丁进入 master 才完成历史事项',async()=>{
    for(const [offset,mode] of ['merge','cherry','squash','partial','unreleased','reverted'].entries()){
      const repo='fixture/'+mode;repository(repo,mode);const delivery=pr(repo,1);issue(100+offset,[delivery.url]);const t=task(100+offset);
      await scan();const result=store.get(t.id), released=['merge','cherry','squash'].includes(mode);
      assert.equal(observed(100+offset),released?'DONE':'READY_FOR_RELEASE',mode);
      assert.equal(Boolean(result.deliveries[0].masterMergedAt),released,mode);
      assert.equal(result.deliveries[0].releaseProof?.method,released?(mode==='merge'?'ancestry':'patch'):undefined);
      assert.equal(result.archivedAt,null);assert.equal(result.cleanup.state,'none');assert(fs.existsSync(repos.get(repo).repo));
    }
  });
  await scenario('历史直接合 master 的正式 PR 可以只读核对，不受新交付必须指向 dev 的限制',async()=>{
    repository('fixture/CodeFunCore','merge');const d=pr('fixture/CodeFunCore',12);prs.get('fixture/CodeFunCore#12').baseRefName='master';issue(150,[d.url]);const t=task(150);await scan();assert.equal(observed(150),'DONE');assert.equal(store.get(t.id).deliveries[0].base,'master');
  });
  await scenario('跨仓库全部关联 PR 都发布后完成，开放和关闭未合的 PR 均阻止提前完成',async()=>{
    const first=pr('fixture/merge',2),second=pr('fixture/cherry',3,'OPEN');issue(200,[first.url,first.url,second.url]);const t=task(200,[first]);
    await scan();assert.equal(observed(200),'READY_FOR_TEST');assert.equal(store.get(t.id).deliveries.length,2);
    pr('fixture/cherry',3,'CLOSED');await scan();assert.equal(observed(200),'READY_FOR_TEST');assert.match(store.get(t.id).publication.issues[0].error,/关闭/);
    pr('fixture/cherry',3);await scan();assert.equal(observed(200),'DONE');
  });
  await scenario('同一事项分布多个会话时汇总全部登记，归档历史也参与核对且不删除工作区',async()=>{
    issue(300);const a=task(300,[pr('fixture/merge',4)]),b=task(300,[pr('fixture/squash',5,'OPEN')],{archivedAt:'2026-01-01T00:00:00Z'});
    await scan();assert.equal(observed(300),'READY_FOR_TEST');assert.notEqual(store.get(a.id).status,'completed');
    pr('fixture/squash',5);await scan();assert.equal(observed(300),'DONE');assert.equal(store.get(b.id).archivedAt,'2026-01-01T00:00:00Z');
  });
  await scenario('多事项会话分别核对 PR，父事项及无发布证据的事项不会被主 PR 带成完成',async()=>{
    const d=pr('fixture/merge',6);issue(400,[d.url]);issue(401);issue(402,[d.url],{isLeaf:false});
    const t=task(400,[],{relatedIssues:[{number:401,url:'https://issues.example.invalid/401'},{number:402,url:'https://issues.example.invalid/402'}]});
    await scan();assert.equal(observed(400),'DONE');assert.equal(observed(401),'IN_PROGRESS');assert.equal(observed(402),'IN_PROGRESS');assert.notEqual(store.get(t.id).status,'completed');
    issues[401].pullRequests=[d.url];saveIssues(401);await scan();assert.equal(observed(401),'DONE');assert.equal(observed(402),'IN_PROGRESS');assert.equal(store.get(t.id).status,'completed','An associated parent is context, not an unfinished leaf delivery');
  });
  await scenario('只在已登记的本机及远端精确分支发现 PR，普通会话不会被纳入自动状态写入',async()=>{
    const f=repos.get('fixture/merge');git(f.repo,'remote','add','origin','https://github.com/fixture/merge.git');
    const a=pr('fixture/merge',7),b=pr('fixture/cherry',8);branchPrs.set('feature-local',[{number:7,url:a.url,headRefName:'feature-local'}]);branchPrs.set('feature-remote',[{number:8,url:b.url,headRefName:'feature-remote'}]);
    issue(500);const t=task(500,[],{worktrees:[{repo:f.repo,path:f.repo,head:f.head,branch:'feature-local'}],remoteWorktrees:[{host:'bbdev',task:'fixture',path:'/fixture/owned',branch:'feature-remote',head:f.head,origin:'https://github.com/fixture/cherry.git',cleanup:{state:'registered',reason:'',checkedAt:null}}]});
    issue(501,[a.url]);const ordinary=task(501,[],{workflowSource:undefined});await scan();
    assert.equal(store.get(t.id).deliveries.length,2);assert.equal(observed(500),'DONE');assert.equal(observed(501),'IN_PROGRESS');assert.equal(store.get(ordinary.id).publication,undefined);
  });
  await scenario('核对并发修改、网络失败、人工完成后不可读均不使用旧合入时间推进状态',async()=>{
    issue(600);const t=task(600,[pr('fixture/merge',9)]);
    changeDuringRead=()=>store.update(t.id,{deliveries:[pr('fixture/partial',10)]});await scan();assert.equal(observed(600),'IN_PROGRESS');assert.equal(store.get(t.id).deliveries[0].pr,10);
    issue(601,[pr('fixture/merge',11).url],{status:'DONE'});const done=task(601);apiFailure=true;await scan();apiFailure=false;
    assert.equal(observed(601),'DONE');assert.notEqual(store.get(done.id).status,'completed');assert.match(store.get(done.id).publication.issues[0].error,/核对/);
  });
  await scenario('重复全量核对不制造动态记录，Git 检查临时索引已经清理',async()=>{
    await scan();const counts=()=>store.db.prepare('SELECT count(*) AS n FROM events').get().n;const before=counts();await scan();assert.equal(counts(),before);
    assert.equal(fs.readdirSync(process.env.CODEX_WORKFLOW_DATA).filter(name=>name.startsWith('release-index-')).length,0);
  });
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{
  store.close();for(const key of Object.keys(process.env))if(!(key in saved))delete process.env[key];Object.assign(process.env,saved);
  if(process.platform==='win32'){
    const literal=root.replace(/'/g,"''");cp.execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`$p=Get-Item -LiteralPath '${literal}'; Get-ChildItem -LiteralPath $p.FullName -Recurse -Force | ForEach-Object {$_.Attributes=$_.Attributes -band (-bnot ([IO.FileAttributes]::ReadOnly -bor [IO.FileAttributes]::Hidden))}; Remove-Item -LiteralPath $p.FullName -Recurse -ErrorAction Stop`],{windowsHide:true});
  }else fs.rmSync(root,{recursive:true});
});
