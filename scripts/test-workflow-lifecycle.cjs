const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const {randomUUID} = require('node:crypto');
const childProcess = require('node:child_process');
const {promisify} = require('node:util');
const ts = require('typescript');

// Git, SQLite, HTTP handlers and lifecycle decisions run unchanged. Only external services are fixtures.
const sourceRoot = path.resolve('src/server/workflow');
const moduleCache = new Map();
let github = new Map(), githubCalls = [];
const externalExecFile = (...args) => childProcess.execFile(...args);
externalExecFile[promisify.custom] = async (executable, args, options) => {
  if (executable !== 'gh') return promisify(childProcess.execFile)(executable, args, options);
  githubCalls.push(args);
  let value;
  if (args[0] === 'pr') value = github.get(`${args[4]}#${args[2]}`)?.pr;
  else if (args[0] === 'api') value = github.get(args[1]);
  assert.notEqual(value, undefined, `Unregistered external GitHub request: ${args.join(' ')}`);
  value = await value;
  if (value instanceof Error) throw value;
  return {stdout: JSON.stringify(value), stderr: ''};
};
function load(name) {
  const file = path.join(sourceRoot, name + '.ts');
  if (moduleCache.has(file)) return moduleCache.get(file).exports;
  const item = new Module(file, module);
  item.filename = file;
  item.paths = Module._nodeModulePaths(path.dirname(file));
  const nativeRequire = item.require.bind(item);
  item.require = id => {
    if (id === 'node:child_process') return {...childProcess, execFile: externalExecFile};
    if (id.startsWith('./')) return load(id.slice(2).replace(/\.js$/, ''));
    return nativeRequire(id);
  };
  moduleCache.set(file, item);
  item._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
  }).outputText, file);
  return item.exports;
}
const {WorkflowStore} = load('store');
const {WorkflowLifecycle} = load('lifecycle');
const {removeWorktree} = load('git');
const {registerWorkflow} = load('routes');
const prefix = '/__backend/workflow';
const savedEnvironment = {...process.env};
const previousHost = global.__codexWorkflowHost;
const stores = new Set();
let root, scenarioRoot, serial = 0, conversations, nativeThreads, nativeFullThreads, nativeReadCalls, archived, archiveMode, projects, removedProjects;
const git = (repo, ...args) => childProcess.execFileSync('git', ['-C', repo, ...args], {encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']}).trim();
function fixtureDirectory(name) {
  const directory = path.join(scenarioRoot, name);
  fs.mkdirSync(directory, {recursive: true});
  return directory;
}
function storeFixture() {
  const store = new WorkflowStore(fixtureDirectory('store-' + ++serial));
  stores.add(store);
  return store;
}
function makeTask(store, patch = {}) {
  const created = store.create(randomUUID(), {title: 'Fixture task', kind: 'feature', prompt: 'Fixture requirement', cwd: scenarioRoot});
  store.update(created.task.id, {managed: true, status: 'running', stage: 'verification', ...patch});
  return {...created, task: store.get(created.task.id)};
}
function threadFixture(cwd, runtime = 'idle', pending = 0) {
  const id = randomUUID();
  nativeThreads.set(id, {id, cwd, status: {type: runtime}});
  conversations.set(id, {threadRuntimeStatus: {type: runtime}, requests: Array.from({length: pending}, () => ({})), turns: []});
  return id;
}
function deliveryFixture(pr = 1, state = 'OPEN', release = false, head = 'a'.repeat(40)) {
  const repo = 'fixture/workflow', merge = String(pr).padStart(40, '0');
  github.set(`${repo}#${pr}`, {pr: {state, baseRefName: 'dev', headRefOid: head,
    mergeCommit: state === 'MERGED' ? {oid: merge} : null, mergedAt: state === 'MERGED' ? '2026-01-02T03:04:05Z' : null,
    url: `https://github.com/${repo}/pull/${pr}`}});
  github.set(`repos/${repo}/compare/${merge}...dev`, {status: 'ahead'});
  github.set(`repos/${repo}/compare/${merge}...master`, {status: release ? 'ahead' : 'diverged'});
  return {repo, pr, url: `https://github.com/${repo}/pull/${pr}`, base: 'dev', release: 'master'};
}
function worktreeFixture() {
  const directory = fixtureDirectory('git-' + ++serial);
  const repo = path.join(directory, 'repo'), target = path.join(directory, 'task'), sibling = path.join(directory, 'sibling');
  fs.mkdirSync(repo);
  git(repo, 'init', '-b', 'dev');
  git(repo, 'config', 'user.name', 'Workflow Fixture');
  git(repo, 'config', 'user.email', 'fixture@users.noreply.github.com');
  git(repo, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'initial\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'ignored.log\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-m', 'Fixture base');
  git(repo, 'remote', 'add', 'origin', 'https://github.com/fixture/workflow.git');
  git(repo, 'worktree', 'add', '-b', 'feature-fixture', target);
  fs.appendFileSync(path.join(target, 'tracked.txt'), 'feature\n');
  git(target, 'commit', '-am', 'Fixture feature');
  const head = git(target, 'rev-parse', 'HEAD');
  git(repo, 'worktree', 'add', '-b', 'sibling-fixture', sibling, 'dev');
  fs.writeFileSync(path.join(sibling, 'personal.txt'), 'preserve sibling data\n');
  return {repo, target, sibling, head, worktree: {repo, path: target, branch: 'feature-fixture', head}};
}
function helperCalls() {
  const file = process.env.WORKFLOW_FIXTURE_CALLS;
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
}
function resetScenario() {
  scenarioRoot = path.join(root, 'case-' + ++serial);
  fs.mkdirSync(scenarioRoot);
  github = new Map(); githubCalls = [];
  conversations = new Map(); nativeThreads = new Map(); archived = []; archiveMode = 'confirm'; projects = {}; removedProjects = [];
  nativeFullThreads = new Map(); nativeReadCalls = [];
  process.env.CODEX_HOME = fixtureDirectory('home');
  process.env.CODEX_WORKFLOW_CWD = scenarioRoot;
  process.env.CODEX_WORKFLOW_DATA = fixtureDirectory('routes-data');
  process.env.CODEX_WORKFLOW_LOCAL_URL = 'http://workflow.example.invalid';
  process.env.CODEX_WORKFLOW_ISSUE_URL = 'https://issues.example.invalid/my-tasks';
  process.env.WORKFLOW_FIXTURE_CALLS = path.join(scenarioRoot, 'external-calls.jsonl');
  process.env.WORKFLOW_FIXTURE_MOBIUS_STATUS = 'IN_PROGRESS';
  process.env.WORKFLOW_FIXTURE_RESOURCE_RELEASED = 'true';
  process.env.WORKFLOW_FIXTURE_MOBIUS_FAIL = '';
  global.__codexWorkflowHost = {
    appServerManagersService: {},
    hostAppServerManagers: {getCurrent: () => ({resource: {manager: {
      getConversation: id => conversations.get(id),
      async archiveConversation(id, options) {
        archived.push({id, options});
        if (archiveMode === 'throw') throw Error('Fixture archive unavailable');
        if (archiveMode === 'confirm') nativeThreads.get(id).archived = true;
      },
    }}})},
    getLocalAppServerClient: () => ({
      async readThread(id, options) {
        assert(nativeThreads.has(id), 'Only fixture threads may be read');
        nativeReadCalls.push({id, includeTurns: options?.includeTurns});
        return options?.includeTurns ? nativeFullThreads.get(id) ?? nativeThreads.get(id) : nativeThreads.get(id);
      },
      async listThreads(input) { return {data: [...nativeThreads.values()].filter(t => Boolean(t.archived) === Boolean(input.archived)), nextCursor: null}; },
      registerInternalNotificationHandler() { return () => {}; },
    }),
    projectsManager: {
      getLocalProjects: () => projects,
      async removeLocal(id) { removedProjects.push(id); delete projects[id]; },
    },
  };
}
async function reconcile(store, id, archive = true) { return new WorkflowLifecycle(store, scenarioRoot).reconcile(id, archive); }
const scenarios = [];
function scenario(name, run) { scenarios.push({name, run}); }

scenario('进入验收才请求待测试；Möbius 返回状态与目标状态分别保存', async () => {
  const store = storeFixture();
  const {task} = makeTask(store, {issue: {number: 101, url: 'https://issues.example.invalid/101'}});
  const result = await reconcile(store, task.id);
  assert.equal(result.mobius.desired, 'READY_FOR_TEST');
  assert.equal(result.mobius.status, 'READY_FOR_TEST');
  assert.equal(helperCalls()[0].desired, 'READY_FOR_TEST');
  assert.equal(archived.length, 0);
  process.env.WORKFLOW_FIXTURE_MOBIUS_FAIL = 'true';
  const failed = await reconcile(store, task.id);
  assert.match(failed.mobius.error, /未同步/);
  assert.equal(failed.mobius.status, 'READY_FOR_TEST', 'A failed write must retain the last confirmed state');
});

scenario('两个 PR 必须全部合 dev 才待发布，全部进 master 才完成并归档原会话', async () => {
  const store = storeFixture(), id = threadFixture(scenarioRoot);
  const first = deliveryFixture(1, 'MERGED'), second = deliveryFixture(2, 'OPEN');
  const {task} = makeTask(store, {threadId: id, issue: {number: 102, url: 'https://issues.example.invalid/102'}, deliveries: [first, second]});
  let result = await reconcile(store, task.id);
  assert.equal(result.mobius.status, 'READY_FOR_TEST'); assert.equal(result.cleanup.state, 'none');
  deliveryFixture(2, 'MERGED');
  result = await reconcile(store, task.id);
  assert.equal(result.mobius.status, 'READY_FOR_RELEASE'); assert.equal(result.cleanup.state, 'released');
  assert.equal(result.archivedAt, null); assert.equal(archived.length, 0);
  deliveryFixture(1, 'MERGED', true);
  result = await reconcile(store, task.id);
  assert.equal(result.mobius.status, 'READY_FOR_RELEASE'); assert.equal(result.archivedAt, null);
  deliveryFixture(2, 'MERGED', true);
  result = await reconcile(store, task.id);
  assert.equal(result.mobius.status, 'DONE'); assert.equal(result.status, 'completed'); assert.equal(result.stage, 'done');
  assert(result.archivedAt); assert.equal(archived.length, 1); assert.equal(archived[0].id, id);
  assert.deepEqual(helperCalls().map(c => c.desired), ['READY_FOR_TEST', 'READY_FOR_RELEASE', 'READY_FOR_RELEASE', 'DONE']);
});

scenario('仅索引的事项只读 Möbius，不因旧会话阶段写业务状态或释放资源', async () => {
  const store = storeFixture(), fixture = worktreeFixture();
  const {task} = makeTask(store, {managed: false, imported: true, stage: 'done', status: 'completed',
    issue: {number: 103, url: 'https://issues.example.invalid/103'}, deliveries: [deliveryFixture(1, 'MERGED', true, fixture.head)], worktrees: [fixture.worktree]});
  const result = await reconcile(store, task.id);
  assert.equal(result.mobius.desired, null); assert.equal(result.mobius.status, 'IN_PROGRESS');
  assert.equal(helperCalls()[0].desired, null); assert.equal(result.archivedAt, null);
  assert(fs.existsSync(fixture.target)); assert.equal(result.cleanup.state, 'none');
});

scenario('登记过的合入时间不能替代 GitHub 事实，未合 PR 不释放不完成', async () => {
  const store = storeFixture(), fixture = worktreeFixture();
  const delivery = {...deliveryFixture(1, 'OPEN', false, fixture.head), devMergedAt: '2026-01-01', masterMergedAt: '2026-01-01'};
  const {task} = makeTask(store, {stage: 'done', status: 'completed', deliveries: [delivery], worktrees: [fixture.worktree]});
  const result = await reconcile(store, task.id);
  assert.equal(result.deliveries[0].devMergedAt, undefined); assert.equal(result.deliveries[0].masterMergedAt, undefined);
  assert.equal(result.cleanup.state, 'none'); assert(fs.existsSync(fixture.target)); assert.equal(archived.length, 0);
});

scenario('GitHub 合入提交已不在 dev 时保留工作区与本地分支', async () => {
  const store = storeFixture(), fixture = worktreeFixture();
  const delivery = deliveryFixture(1, 'MERGED', false, fixture.head);
  github.set('repos/fixture/workflow/compare/' + '1'.padStart(40, '0') + '...dev', {status: 'diverged'});
  const {task} = makeTask(store, {deliveries: [delivery], worktrees: [fixture.worktree]});
  const result = await reconcile(store, task.id);
  assert.equal(result.deliveries[0].devMergedAt, undefined); assert(fs.existsSync(fixture.target));
  assert.equal(git(fixture.repo, 'rev-parse', 'feature-fixture'), fixture.head);
});

scenario('干净且空闲的 dev 工作区、任务分支和临时入口释放，主项目及其他 worktree 保留', async () => {
  const store = storeFixture(), fixture = worktreeFixture(), id = threadFixture(fixture.target);
  projects = {root: {id: 'root', rootPaths: [scenarioRoot]}, task: {id: 'task', rootPaths: [fixture.target]}, sibling: {id: 'sibling', rootPaths: [fixture.sibling]}};
  const {task} = makeTask(store, {threadId: id, cwd: fixture.target, deliveries: [deliveryFixture(1, 'MERGED', false, fixture.head)], worktrees: [fixture.worktree]});
  const result = await reconcile(store, task.id);
  assert.equal(result.cleanup.state, 'released', result.cleanup.reason); assert(!fs.existsSync(fixture.target));
  assert.equal(git(fixture.repo, 'for-each-ref', '--format=%(refname)', 'refs/heads/feature-fixture'), '');
  assert.equal(fs.readFileSync(path.join(fixture.sibling, 'personal.txt'), 'utf8'), 'preserve sibling data\n');
  assert(fs.existsSync(fixture.repo)); assert(projects.root); assert(projects.sibling); assert.deepEqual(removedProjects, ['task']);
  assert(result.worktrees[0].releasedAt); assert.deepEqual(result.projectsRemoved, ['task']); assert.equal(archived.length, 0);
});

for (const condition of ['tracked', 'untracked', 'ignored', 'head']) scenario(`dev 已合入但 ${condition} 变化时保留工作区和分支`, async () => {
  const store = storeFixture(), fixture = worktreeFixture();
  if (condition === 'tracked') fs.appendFileSync(path.join(fixture.target, 'tracked.txt'), 'personal change\n');
  if (condition === 'untracked') fs.writeFileSync(path.join(fixture.target, 'notes.txt'), 'personal data\n');
  if (condition === 'ignored') fs.writeFileSync(path.join(fixture.target, 'ignored.log'), 'personal cache\n');
  if (condition === 'head') { fs.appendFileSync(path.join(fixture.target, 'tracked.txt'), 'later work\n'); git(fixture.target, 'commit', '-am', 'Fixture later work'); }
  const expectedHead = git(fixture.target, 'rev-parse', 'HEAD');
  const {task} = makeTask(store, {deliveries: [deliveryFixture(1, 'MERGED', false, fixture.head)], worktrees: [fixture.worktree]});
  const result = await reconcile(store, task.id);
  assert.equal(result.cleanup.state, 'blocked');
  assert.match(result.cleanup.reason, condition === 'head' ? /提交或分支已改变/ : /未提交、未跟踪或被忽略/);
  assert(fs.existsSync(fixture.target)); assert.equal(git(fixture.repo, 'rev-parse', 'feature-fixture'), expectedHead);
  assert.equal(fs.readFileSync(path.join(fixture.sibling, 'personal.txt'), 'utf8'), 'preserve sibling data\n');
});

for (const condition of ['running', 'approval', 'other-native-chat']) scenario(`dev 已合入但 ${condition} 占用时保留工作区`, async () => {
  const store = storeFixture(), fixture = worktreeFixture();
  const id = threadFixture(fixture.target, condition === 'running' ? 'active' : 'idle', condition === 'approval' ? 1 : 0);
  if (condition === 'other-native-chat') threadFixture(fixture.target, 'active');
  const {task} = makeTask(store, {threadId: id, cwd: fixture.target, deliveries: [deliveryFixture(1, 'MERGED', false, fixture.head)], worktrees: [fixture.worktree]});
  const result = await reconcile(store, task.id);
  assert.equal(result.cleanup.state, 'blocked'); assert.match(result.cleanup.reason, /仍在运行或等待回应|还有运行中的会话/);
  assert(fs.existsSync(fixture.target)); assert.equal(git(fixture.repo, 'rev-parse', 'feature-fixture'), fixture.head);
});

scenario('未加载会话最后一轮已完成，读取历史确认后可释放并归档', async () => {
  const store = storeFixture(), fixture = worktreeFixture(), id = threadFixture(fixture.target, 'notLoaded');
  conversations.delete(id);
  nativeFullThreads.set(id, {...nativeThreads.get(id), turns: [{status: 'completed', items: []}]});
  const {task} = makeTask(store, {threadId: id, deliveries: [deliveryFixture(1, 'MERGED', true, fixture.head)], worktrees: [fixture.worktree]});
  const result = await reconcile(store, task.id);
  assert.equal(result.cleanup.state, 'released', result.cleanup.reason); assert(!fs.existsSync(fixture.target));
  assert(result.archivedAt); assert.equal(archived.length, 1);
  assert(nativeReadCalls.some(call => call.id === id && call.includeTurns === true));
});

for (const condition of ['active', 'approval', 'unfinished', 'unknown']) scenario(`未加载会话历史回读为 ${condition} 时保留工作区并禁止归档`, async () => {
  const store = storeFixture(), fixture = worktreeFixture(), id = threadFixture(fixture.target, 'notLoaded');
  conversations.delete(id);
  nativeFullThreads.set(id, {...nativeThreads.get(id),
    status: condition === 'active' || condition === 'approval' ? {type: 'active', flags: condition === 'approval' ? ['waitingOnApproval'] : []} : {type: 'notLoaded'},
    turns: condition === 'unknown' ? [] : [{status: condition === 'unfinished' ? 'inProgress' : 'completed', items: []}],
  });
  const {task} = makeTask(store, {threadId: id, deliveries: [deliveryFixture(1, 'MERGED', true, fixture.head)], worktrees: [fixture.worktree]});
  const result = await reconcile(store, task.id);
  assert.equal(result.cleanup.state, 'blocked', 'Historical completed turns must not override a current active or unknown state');
  assert.match(result.cleanup.reason, /仍在运行或等待回应/); assert(fs.existsSync(fixture.target));
  assert.equal(git(fixture.repo, 'rev-parse', 'feature-fixture'), fixture.head);
  assert.equal(result.archivedAt, null); assert.equal(archived.length, 0);
  assert(nativeReadCalls.some(call => call.id === id && call.includeTurns === true));
});

scenario('master 查询失败不否定已核实的 dev 合入，可释放干净工作区但不能归档', async () => {
  const store = storeFixture(), fixture = worktreeFixture();
  const delivery = deliveryFixture(1, 'MERGED', false, fixture.head);
  github.set('repos/fixture/workflow/compare/' + '1'.padStart(40, '0') + '...master', Error('Fixture unavailable'));
  const {task} = makeTask(store, {deliveries: [delivery], worktrees: [fixture.worktree]});
  const result = await reconcile(store, task.id);
  assert(result.deliveries[0].devMergedAt); assert.equal(result.deliveries[0].masterMergedAt, undefined);
  assert.equal(result.cleanup.state, 'released', result.cleanup.reason); assert(!fs.existsSync(fixture.target)); assert.equal(result.archivedAt, null);
});

scenario('master 已完成但工作区有未提交改动：事项完成，资源保留，会话暂不归档', async () => {
  const store = storeFixture(), fixture = worktreeFixture(), id = threadFixture(fixture.target);
  fs.appendFileSync(path.join(fixture.target, 'tracked.txt'), 'preserve follow-up work\n');
  const {task} = makeTask(store, {threadId: id, issue: {number: 106, url: 'https://issues.example.invalid/106'},
    deliveries: [deliveryFixture(1, 'MERGED', true, fixture.head)], worktrees: [fixture.worktree]});
  const result = await reconcile(store, task.id);
  assert.equal(result.mobius.status, 'DONE'); assert.equal(result.status, 'completed');
  assert.equal(result.cleanup.state, 'blocked'); assert(fs.existsSync(fixture.target)); assert.equal(archived.length, 0);
});

scenario('登记 PR 属于其他仓库时不能删除当前仓库工作区', async () => {
  const store = storeFixture(), fixture = worktreeFixture();
  git(fixture.repo, 'remote', 'set-url', 'origin', 'https://github.com/fixture/other-repository.git');
  const {task} = makeTask(store, {deliveries: [deliveryFixture(1, 'MERGED', false, fixture.head)], worktrees: [fixture.worktree]});
  const result = await reconcile(store, task.id);
  assert.equal(result.cleanup.state, 'blocked'); assert.match(result.cleanup.reason, /未与已合入的 PR 对应/);
  assert(fs.existsSync(fixture.target)); assert.equal(git(fixture.repo, 'rev-parse', 'feature-fixture'), fixture.head);
});

scenario('Git 回收过程中另一操作者推进分支时保留新分支，重试不能误删新提交', async () => {
  const fixture = worktreeFixture();
  const oldHead = fixture.head, newHead = git(fixture.repo, 'rev-parse', 'dev');
  let recorded;
  const delivery = {...deliveryFixture(1, 'MERGED', false, oldHead), head: oldHead, devMergedAt: '2026-01-02T03:04:05Z'};
  await assert.rejects(removeWorktree(fixture.worktree, scenarioRoot, [delivery], value => {
    recorded = value;
    if (value.removedAt && !value.releasedAt) git(fixture.repo, 'update-ref', 'refs/heads/feature-fixture', newHead, oldHead);
  }), /任务分支提交已改变，已保留分支/);
  assert(!fs.existsSync(fixture.target)); assert(recorded.removalStartedAt); assert(recorded.removedAt); assert.equal(recorded.releasedAt, undefined);
  assert.equal(git(fixture.repo, 'rev-parse', 'feature-fixture'), newHead);
  await assert.rejects(removeWorktree(recorded, scenarioRoot, [delivery], () => {}), /任务分支提交已改变，已保留分支/);
  assert.equal(git(fixture.repo, 'rev-parse', 'feature-fixture'), newHead);
  assert(fs.existsSync(fixture.sibling));
});

scenario('资源释放拒绝时保留工作区，重试仅释放登记的资源并保存确认结果', async () => {
  const store = storeFixture(), fixture = worktreeFixture();
  const resource = {kind: 'bbdev-lease', task: 'fixture-task', lease: 'fixture-lease', released: false};
  const {task} = makeTask(store, {resources: [resource], deliveries: [deliveryFixture(1, 'MERGED', false, fixture.head)], worktrees: [fixture.worktree]});
  process.env.WORKFLOW_FIXTURE_RESOURCE_RELEASED = 'false';
  let result = await reconcile(store, task.id);
  assert.equal(result.cleanup.state, 'blocked'); assert.equal(result.resources[0].released, false); assert(fs.existsSync(fixture.target));
  process.env.WORKFLOW_FIXTURE_RESOURCE_RELEASED = 'true';
  result = await reconcile(store, task.id);
  assert.equal(result.cleanup.state, 'released', result.cleanup.reason); assert.equal(result.resources[0].released, true); assert(!fs.existsSync(fixture.target));
  assert.equal(helperCalls().length, 2);
  assert(helperCalls().every(c => c.task === resource.task && c.lease === resource.lease));
});

scenario('master 完成但 Möbius 写失败或原生归档未回读成功时，不声称会话已归档', async () => {
  const store = storeFixture(), id = threadFixture(scenarioRoot);
  const {task} = makeTask(store, {threadId: id, issue: {number: 104, url: 'https://issues.example.invalid/104'}, deliveries: [deliveryFixture(1, 'MERGED', true)]});
  process.env.WORKFLOW_FIXTURE_MOBIUS_FAIL = 'true';
  let result = await reconcile(store, task.id);
  assert.equal(result.mobius.desired, 'DONE'); assert.equal(result.archivedAt, null); assert.equal(archived.length, 0);
  process.env.WORKFLOW_FIXTURE_MOBIUS_FAIL = ''; archiveMode = 'unconfirmed';
  result = await reconcile(store, task.id);
  assert.equal(result.mobius.status, 'DONE'); assert.equal(result.archivedAt, null); assert.match(result.error, /归档结果尚未确认/);
});

scenario('已确认 master 完成后 GitHub 暂不可读，只读 Möbius 当前状态，不能回写待测试', async () => {
  const store = storeFixture();
  const delivery = deliveryFixture(1, 'MERGED', true);
  const {task} = makeTask(store, {issue: {number: 108, url: 'https://issues.example.invalid/108'}, deliveries: [delivery]});
  let result = await reconcile(store, task.id, false);
  assert.equal(result.mobius.status, 'DONE');
  github.set('fixture/workflow#1', {pr: Error('Fixture GitHub unavailable')});
  process.env.WORKFLOW_FIXTURE_MOBIUS_STATUS = 'DONE';
  result = await reconcile(store, task.id, false);
  assert.equal(result.mobius.status, 'DONE'); assert.equal(result.mobius.desired, null);
  assert.deepEqual(helperCalls().map(call => call.desired), ['DONE', null]);
});

scenario('HTTP 上报凭据、范围和元数据登记边界；刷新实际执行 Möbius 同步', async () => {
  const app = require('fastify')();
  const id = threadFixture(scenarioRoot);
  try {
    await registerWorkflow(app);
    const service = JSON.parse(fs.readFileSync(path.join(process.env.CODEX_WORKFLOW_DATA, 'service.json'), 'utf8'));
    const attach = await app.inject({method: 'POST', url: prefix + '/attach', headers: {authorization: 'Bearer ' + service.agentToken}, payload: {threadId: id}});
    assert.equal(attach.statusCode, 200, attach.body);
    const context = attach.json(), reportUrl = prefix + '/' + context.workflowId + '/report';
    const unauthorized = await app.inject({method: 'POST', url: reportUrl, payload: {stage: 'verification'}});
    assert.equal(unauthorized.statusCode, 403);
    const initial = (await app.inject(prefix + '/' + context.workflowId)).json();
    assert.equal(initial.managed, false); assert.equal(initial.stage, 'intake');
    const headers = {authorization: 'Bearer ' + context.token};
    const outside = await app.inject({method: 'POST', url: reportUrl, headers, payload: {worktrees: [{repo: path.dirname(root), path: path.join(path.dirname(root), 'outside'), branch: 'feature-fixture', head: 'a'.repeat(40)}]}});
    assert.equal(outside.statusCode, 400); assert.match(outside.json().error, /项目目录内/);
    const report = await app.inject({method: 'POST', url: reportUrl, headers, payload: {stage: 'verification', issue: {number: 105}, summary: 'Ready for acceptance'}});
    assert.equal(report.statusCode, 200, report.body); assert.equal(report.json().managed, true);
    assert.equal(report.json().issue.url, 'https://issues.example.invalid/my-tasks?issue=105');
    await waitFor(async () => (await app.inject(prefix + '/' + context.workflowId)).json().mobius.status === 'READY_FOR_TEST');
    for (const action of ['refresh', context.workflowId + '/release', context.workflowId + '/archive']) {
      const denied = await app.inject({method: 'POST', url: prefix + '/' + action, headers: {origin: 'https://attacker.invalid'}});
      assert.equal(denied.statusCode, 403);
    }
    const callsBeforeRefresh = helperCalls().length;
    const valid = await app.inject({method: 'POST', url: prefix + '/refresh', headers: {authorization: 'Bearer ' + service.agentToken}});
    assert.equal(valid.statusCode, 202); assert.equal(valid.json().syncing, true);
    await waitFor(async () => helperCalls().length > callsBeforeRefresh &&
      (await app.inject(prefix + '/' + context.workflowId)).json().mobius.status === 'READY_FOR_TEST');
  } finally { await app.close(); }
});

scenario('HTTP caller 伪造 dev/master 合入时间不能把未合 PR 同步为完成或删除工作区', async () => {
  const fixture = worktreeFixture(), app = require('fastify')();
  const id = threadFixture(fixture.target);
  const delivery = {...deliveryFixture(1, 'OPEN', false, fixture.head),
    head: fixture.head, devMergedAt: '2026-01-01T00:00:00Z', masterMergedAt: '2026-01-01T00:00:00Z'};
  try {
    await registerWorkflow(app);
    const service = JSON.parse(fs.readFileSync(path.join(process.env.CODEX_WORKFLOW_DATA, 'service.json'), 'utf8'));
    const attached = await app.inject({method: 'POST', url: prefix + '/attach',
      headers: {authorization: 'Bearer ' + service.agentToken}, payload: {threadId: id}});
    assert.equal(attached.statusCode, 200, attached.body);
    const context = attached.json();
    const report = await app.inject({method: 'POST', url: prefix + '/' + context.workflowId + '/report',
      headers: {authorization: 'Bearer ' + context.token}, payload: {stage: 'done', status: 'completed',
        summary: 'Caller claims completion', issue: {number: 107}, deliveries: [delivery], worktrees: [fixture.worktree]}});
    if (report.statusCode === 400) {
      assert.match(report.body, /additional|properties|合入|字段/i, 'A strict schema may reject caller-supplied server facts');
    } else {
      assert.equal(report.statusCode, 200, report.body);
      await waitFor(async () => (await app.inject(prefix + '/' + context.workflowId)).json().mobius.status === 'READY_FOR_TEST');
    }
    const result = (await app.inject(prefix + '/' + context.workflowId)).json();
    assert.notEqual(result.mobius.status, 'DONE'); assert.equal(result.archivedAt, null);
    assert.equal(result.cleanup.state, 'none');
    assert(result.deliveries.every(item => !item.devMergedAt && !item.masterMergedAt));
    assert(fs.existsSync(fixture.target)); assert.equal(git(fixture.repo, 'rev-parse', 'feature-fixture'), fixture.head);
    assert.equal(archived.length, 0);
  } finally { await app.close(); }
});

scenario('HTTP 核对 GitHub 期间拒绝并发覆盖登记，完成核对后保留原登记', async () => {
  const app = require('fastify')(), id = threadFixture(scenarioRoot);
  const delivery = deliveryFixture(1, 'OPEN'), prResponse = github.get('fixture/workflow#1').pr;
  let finishGithub;
  github.set('fixture/workflow#1', {pr: new Promise(resolve => { finishGithub = () => resolve(prResponse); })});
  try {
    await registerWorkflow(app);
    const service = JSON.parse(fs.readFileSync(path.join(process.env.CODEX_WORKFLOW_DATA, 'service.json'), 'utf8'));
    const attached = await app.inject({method: 'POST', url: prefix + '/attach',
      headers: {authorization: 'Bearer ' + service.agentToken}, payload: {threadId: id}});
    assert.equal(attached.statusCode, 200, attached.body);
    const context = attached.json(), headers = {authorization: 'Bearer ' + context.token};
    const url = prefix + '/' + context.workflowId + '/report';
    const first = await app.inject({method: 'POST', url, headers,
      payload: {stage: 'verification', issue: {number: 109}, deliveries: [{repo: delivery.repo, pr: delivery.pr, base: 'dev', release: 'master'}]}});
    assert.equal(first.statusCode, 200, first.body);
    const concurrent = await app.inject({method: 'POST', url, headers, payload: {deliveries: [], summary: 'Concurrent replacement'}});
    assert.equal(concurrent.statusCode, 409); assert.match(concurrent.json().error, /正在核对/);
    finishGithub();
    await waitFor(async () => (await app.inject(prefix + '/' + context.workflowId)).json().mobius.status === 'READY_FOR_TEST');
    const observed = (await app.inject(prefix + '/' + context.workflowId)).json();
    assert.equal(observed.deliveries.length, 1); assert.equal(observed.deliveries[0].pr, 1);
    assert.notEqual(observed.summary, 'Concurrent replacement');
  } finally { finishGithub?.(); await app.close(); }
});

async function waitFor(predicate) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw Error('Timed out waiting for the real asynchronous report reconciliation');
}

function cleanupFixture(directory) {
  const temporaryParent = path.resolve('runtime/tmp');
  assert.equal(path.dirname(directory), temporaryParent);
  assert(path.basename(directory).startsWith('workflow-lifecycle-'));
  if (!fs.existsSync(directory)) return;
  assert.equal(fs.realpathSync(directory).toLowerCase(), directory.toLowerCase());
  if (process.platform === 'win32') {
    const literal = directory.replace(/'/g, "''");
    const script = "$taskFixture = Get-Item -LiteralPath '" + literal + "'; " +
      "$taskAttributes = [IO.FileAttributes]::ReadOnly -bor [IO.FileAttributes]::Hidden; " +
      "Get-ChildItem -LiteralPath $taskFixture.FullName -Recurse -Force | ForEach-Object { $_.Attributes = $_.Attributes -band (-bnot $taskAttributes) }; " +
      "$taskFixture.Attributes = $taskFixture.Attributes -band (-bnot $taskAttributes); " +
      "Remove-Item -LiteralPath $taskFixture.FullName -Recurse -ErrorAction Stop";
    childProcess.execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {windowsHide: true, stdio: 'pipe'});
  } else fs.rmSync(directory, {recursive: true});
}

(async () => {
  const temporaryParent = path.resolve('runtime/tmp');
  fs.mkdirSync(temporaryParent, {recursive: true});
  root = fs.mkdtempSync(path.join(temporaryParent, 'workflow-lifecycle-'));
  const helper = path.join(root, 'external-helper.py');
  fs.writeFileSync(helper, `import argparse,json,os,sys\np=argparse.ArgumentParser()\nfor key in ['number','desired','kind','task','lease','slot']: p.add_argument('--'+key)\na=vars(p.parse_args())\nwith open(os.environ['WORKFLOW_FIXTURE_CALLS'],'a',encoding='utf8') as f: f.write(json.dumps(a)+'\\n')\nif a['number']:\n if os.environ.get('WORKFLOW_FIXTURE_MOBIUS_FAIL'): sys.exit('Fixture Mobius unavailable')\n print(json.dumps({'status':a['desired'] or os.environ['WORKFLOW_FIXTURE_MOBIUS_STATUS']}))\nelse: print(json.dumps({'released':os.environ['WORKFLOW_FIXTURE_RESOURCE_RELEASED']=='true','error':'Fixture lease still active'}))\n`);
  process.env.CODEX_WORKFLOW_MOBIUS_HELPER = helper;
  process.env.CODEX_WORKFLOW_RESOURCE_HELPER = helper;
  process.env.CODEX_WORKFLOW_PYTHON = process.env.CODEX_WORKFLOW_TEST_PYTHON || 'python';
  let failures = 0;
  try {
    for (const item of scenarios) {
      resetScenario();
      try { await item.run(); console.log('PASS:', item.name); }
      catch (error) { failures++; console.error('FAIL:', item.name); console.error(error); }
      finally { for (const store of stores) store.close(); stores.clear(); }
    }
  } finally {
    global.__codexWorkflowHost = previousHost;
    for (const key of Object.keys(process.env)) if (!(key in savedEnvironment)) delete process.env[key];
    Object.assign(process.env, savedEnvironment);
    cleanupFixture(root);
  }
  assert.equal(failures, 0, `${failures} workflow lifecycle scenarios failed`);
  console.log(`PASS: ${scenarios.length} workflow lifecycle and HTTP business boundary scenarios`);
})().catch(error => { console.error(error); process.exitCode = 1; });
