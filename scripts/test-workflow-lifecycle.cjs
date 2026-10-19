const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const {randomUUID} = require('node:crypto');
const childProcess = require('node:child_process');
const {promisify} = require('node:util');
const ts = require('typescript');
const Database = require('better-sqlite3');

// Git, SQLite, HTTP handlers and lifecycle decisions run unchanged. Only external services are fixtures.
const sourceRoot = path.resolve('src/server/workflow');
const moduleCache = new Map();
let github = new Map(), githubCalls = [];
const externalExecFile = (...args) => childProcess.execFile(...args);
externalExecFile[promisify.custom] = async (executable, args, options) => {
  if (executable !== 'gh') return promisify(childProcess.execFile)(executable, args, options);
  githubCalls.push(args);
  let value;
  if (args[0] === 'pr' && args[1] === 'list') value = [];
  else if (args[0] === 'pr') value = github.get(`${args[4]}#${args[2]}`)?.pr;
  else if (args[0] === 'repo') value = {defaultBranchRef:{name:'master'}};
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
// Observe completion without replacing lifecycle decisions or subprocess execution.
const reconciliations = [];
const originalReconcile = WorkflowLifecycle.prototype.reconcile;
WorkflowLifecycle.prototype.reconcile = function(id, archive) {
  this.invalidatePublication();
  const operation = originalReconcile.call(this, id, archive);
  reconciliations.push({id, operation, startedAt: Date.now()});
  return operation;
};
const {removeWorktree} = load('git');
const {registerWorkflow} = load('routes');
const {importProjectThreads} = load('indexer');
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
  github.set(`${repo}#${pr}`, {pr: {state, isDraft: false, baseRefName: 'dev', headRefOid: head,
    mergeCommit: state === 'MERGED' ? {oid: merge} : null, mergedAt: state === 'MERGED' ? '2026-01-02T03:04:05Z' : null,
    url: `https://github.com/${repo}/pull/${pr}`}});
  github.set(`repos/${repo}/compare/${merge}...dev`, {status: 'ahead'});
  github.set(`repos/${repo}/commits/master`, {sha:'f'.repeat(40)});
  github.set(`repos/${repo}/compare/${merge}...${'f'.repeat(40)}`, {status: release ? 'ahead' : 'behind'});
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
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter(call => !call.inspect) : [];
}
function resetScenario() {
  reconciliations.length = 0;
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
  process.env.WORKFLOW_FIXTURE_REMOTE_RESULT = JSON.stringify({worktrees:[]});
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
      async sendAppServerRequest(method, params) {
        if (method === 'thread/loaded/list') return {data: [...nativeThreads.values()].filter(t => t.status?.type !== 'notLoaded').map(t => t.id), nextCursor: null};
        assert.equal(method, 'thread/read'); assert.equal(params.includeTurns, false);
        assert(nativeThreads.has(params.threadId));
        nativeReadCalls.push({id: params.threadId, includeTurns: false});
        return {thread: nativeThreads.get(params.threadId)};
      },
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

scenario('从当前 Codex SQLite 索引已有项目会话，排除空会话、子代理、归档和其他项目且重复导入不新增', async () => {
  const sourceFile = path.join(process.env.CODEX_HOME, 'state_5.sqlite');
  const source = new Database(sourceFile);
  try {
    source.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, title TEXT, preview TEXT,
      first_user_message TEXT, cwd TEXT, source TEXT, updated_at INTEGER, project_id TEXT,
      archived INTEGER, has_user_event INTEGER, archived_at INTEGER)`);
    const insert = source.prepare('INSERT INTO threads (id,name,title,preview,first_user_message,cwd,source,updated_at,project_id,archived,has_user_event) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
    const entries = [
      ['root-chat', 'Root task', scenarioRoot, 'cli', 'Mobius #321 synthetic requirement', 0],
      ['nested-chat', 'Nested task', path.join(scenarioRoot, 'project'), 'vscode', 'Synthetic feature requirement', 0],
      ['subagent-chat', 'Subagent task', scenarioRoot, '{"subagent":"worker"}', 'Synthetic agent requirement', 0],
      ['outside-chat', 'Outside task', path.join(scenarioRoot + '-outside', 'project'), 'cli', 'Synthetic outside requirement', 0],
      ['archived-chat', 'Archived task', scenarioRoot, 'cli', 'Synthetic archived requirement', 1],
      ['empty-chat', 'Empty task', scenarioRoot, 'vscode', '', 0],
      ['null-chat', 'Null task', scenarioRoot, 'cli', null, 0],
    ];
    for (const [id, name, cwd, origin, prompt, archived] of entries) {
      insert.run(id, name, 'Synthetic title', 'Synthetic preview', prompt, cwd, origin, 1700000000, null, archived, 0);
    }
    assert.equal(source.prepare('SELECT count(*) AS count FROM threads WHERE archived=0 AND has_user_event=1').get().count, 0,
      'The retired has_user_event flag does not identify these existing user conversations');
  } finally { source.close(); }
  const before = fs.readFileSync(sourceFile);
  const directory = fixtureDirectory('index-data'), store = new WorkflowStore(directory);
  stores.add(store);
  await importProjectThreads(store, scenarioRoot, directory);
  const imported = store.list();
  assert.deepEqual(imported.map(task => task.threadId).sort(), ['nested-chat', 'root-chat']);
  assert(imported.every(task => task.imported && task.managed === false));
  const rootTask = imported.find(task => task.threadId === 'root-chat');
  assert.equal(rootTask.prompt, 'Mobius #321 synthetic requirement');
  assert.equal(rootTask.issue.number, 321);
  assert.equal(rootTask.updatedAt, '2023-11-14T22:13:20.000Z');
  assert.equal(imported.find(task => task.threadId === 'nested-chat').cwd, path.join(scenarioRoot, 'project'));
  const contexts = new Map(imported.map(task => {
    const file = path.join(directory, 'contexts', task.id + '.json');
    const text = fs.readFileSync(file, 'utf8'), context = JSON.parse(text);
    assert.equal(context.workflowId, task.id);
    assert.equal(context.endpoint, 'http://workflow.example.invalid/__backend/workflow');
    assert(store.validToken(task.id, context.token));
    return [file, text];
  }));
  const eventCount = store.db.prepare('SELECT count(*) AS count FROM events').get().count;
  await importProjectThreads(store, scenarioRoot, directory);
  assert.deepEqual(store.list(), imported);
  assert.equal(store.db.prepare('SELECT count(*) AS count FROM events').get().count, eventCount);
  assert.equal(fs.readdirSync(path.join(directory, 'contexts')).length, 2);
  for (const [file, text] of contexts) assert.equal(fs.readFileSync(file, 'utf8'), text);
  assert.deepEqual(fs.readFileSync(sourceFile), before, 'Import must leave the source database unchanged');
  assert.deepEqual(nativeReadCalls, []);
  assert.deepEqual(archived, []);
  process.env.CODEX_WORKFLOW_DATA=directory;
  const app=require('fastify')();
  try {
    await registerWorkflow(app);
    for(const [name,title,expected] of [['Renamed native task','Stale generated title','Renamed native task'],['','Updated generated title','Updated generated title']]) {
      const native=new Database(sourceFile);
      try {native.prepare("UPDATE threads SET name=?,title=?,updated_at=1700000300 WHERE id='root-chat'").run(name,title);}
      finally {native.close();}
      const nativeBefore=fs.readFileSync(sourceFile);
      const response=await app.inject(prefix);
      assert.equal(response.statusCode,200,response.body);
      assert.deepEqual(response.json().find(task=>task.id===rootTask.id),{...rootTask,title:expected},
        'HTTP list must follow the native name or generated title without changing workflow progress or metadata');
      assert.deepEqual(fs.readFileSync(sourceFile),nativeBefore,'Title observation must not write native SQLite');
    }
    assert.equal(store.list().length,2);
    for(const [file,text] of contexts) assert.equal(fs.readFileSync(file,'utf8'),text);
  } finally {await app.close();}
});

scenario('既有事项跟随原生 SQLite 归档与取消归档，保留关联和资源且不导入历史归档', async () => {
  const sourceFile = path.join(process.env.CODEX_HOME, 'state_5.sqlite');
  function sourceWrite(run) {
    const db = new Database(sourceFile);
    try { run(db); } finally { db.close(); }
  }
  sourceWrite(db => {
    db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, title TEXT, preview TEXT,
      first_user_message TEXT, cwd TEXT, source TEXT, updated_at INTEGER, project_id TEXT,
      archived INTEGER, archived_at INTEGER)`);
    const insert = db.prepare('INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,?,?,?)');
    insert.run('tracked-chat', 'Original task', 'Original title', 'Original preview', 'Synthetic tracked requirement', scenarioRoot, 'cli', 1700000000, null, 0, null);
    insert.run('historic-chat', 'Historic task', 'Historic title', '', 'Synthetic historical requirement', scenarioRoot, 'cli', 1699999000, null, 1, 1699999500);
  });
  const store = storeFixture(), directory = fixtureDirectory('archive-index');
  await importProjectThreads(store, scenarioRoot, directory);
  assert.deepEqual(store.list().map(task => task.threadId), ['tracked-chat']);
  const original = store.list()[0];
  store.update(original.id, {managed:true, project:'Curated project', issue:{number:501,url:'https://issues.example.invalid/501'},
    summary:'Keep curated progress', stage:'verification', evidence:[{label:'acceptance',value:'Retain evidence'}],
    deliveries:[{repo:'fixture/workflow',pr:31,url:'https://github.com/fixture/workflow/pull/31',base:'dev',release:'master'}],
    worktrees:[{repo:scenarioRoot,path:path.join(scenarioRoot,'owned'),branch:'owned',head:'b'.repeat(40)}],
    resources:[{kind:'bbdev-lease',task:'fixture-task',lease:'fixture-lease',released:false}],
    customMetadata:{source:'reviewed',relatedIssues:[501,502]}});
  const preserved = store.get(original.id);
  const context = path.join(directory, 'contexts', original.id + '.json'), contextBefore = fs.readFileSync(context);
  sourceWrite(db => {
    db.prepare("UPDATE threads SET archived=1,archived_at=1700000100,updated_at=1700000200,name='Renamed elsewhere' WHERE id='tracked-chat'").run();
    const insert = db.prepare('INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,?,?,?)');
    const fill = db.transaction(() => {
      for (let i=0;i<1100;i++) insert.run('outside-'+i, 'Outside', '', '', 'Synthetic outside requirement', scenarioRoot+'-outside', 'cli', 1800000000+i, null, 0, null);
    });
    fill();
  });
  let before = fs.readFileSync(sourceFile);
  await importProjectThreads(store, scenarioRoot, directory);
  assert.deepEqual(store.get(original.id), {...preserved,title:'Renamed elsewhere',archivedAt:'2023-11-14T22:15:00.000Z'},
    'Native archive must hide the existing entry without losing business metadata, resources or progress time');
  assert.equal(store.list().length,1,'Historical archived and outside conversations must not be imported');
  assert.deepEqual(fs.readFileSync(sourceFile),before,'Archive observation must not write the native database');
  const archivedTask = store.get(original.id), eventCount = store.db.prepare('SELECT count(*) AS count FROM events').get().count;
  await importProjectThreads(store, scenarioRoot, directory);
  assert.deepEqual(store.get(original.id),archivedTask);
  assert.equal(store.db.prepare('SELECT count(*) AS count FROM events').get().count,eventCount,'Repeated archive observation must be idempotent');
  sourceWrite(db => db.prepare("UPDATE threads SET archived=0,archived_at=NULL,updated_at=1700000300,name='',title='Updated native title' WHERE id='tracked-chat'").run());
  before = fs.readFileSync(sourceFile);
  await importProjectThreads(store, scenarioRoot, directory);
  assert.deepEqual(store.get(original.id), {...preserved,title:'Updated native title',archivedAt:null},'Unarchive must restore the same entry and metadata while following the native title');
  assert.deepEqual(fs.readFileSync(sourceFile),before);
  assert.deepEqual(fs.readFileSync(context),contextBefore,'Archive changes must not replace progress credentials');
  assert.equal(fs.readdirSync(path.dirname(context)).length,1);
  assert.deepEqual(nativeReadCalls,[]); assert.deepEqual(archived,[]);
});

scenario('进入验收才请求待测试；Möbius 返回状态与目标状态分别保存', async () => {
  const store = storeFixture();
  const {task} = makeTask(store, {issue: {number: 101, url: 'https://issues.example.invalid/101'}});
  const result = await reconcile(store, task.id);
  assert.equal(result.mobius.desired, 'READY_FOR_TEST');
  assert.equal(result.mobius.status, 'READY_FOR_TEST');
  assert.equal(helperCalls()[0].desired, 'READY_FOR_TEST');
  assert.equal(archived.length, 0);
  process.env.WORKFLOW_FIXTURE_MOBIUS_FAIL = 'read';
  const failed = await reconcile(store, task.id);
  assert.match(failed.mobius.error, /核对/);
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

scenario('普通导入会话不因事项编号参与自动核对、写业务状态或释放资源', async () => {
  const store = storeFixture(), fixture = worktreeFixture();
  const {task} = makeTask(store, {managed: false, imported: true, stage: 'done', status: 'completed',
    issue: {number: 103, url: 'https://issues.example.invalid/103'}, deliveries: [deliveryFixture(1, 'MERGED', true, fixture.head)], worktrees: [fixture.worktree]});
  const result = await reconcile(store, task.id);
  assert.equal(result.mobius.desired, null); assert.equal(result.mobius.status, null);
  assert.equal(helperCalls().length, 0); assert.equal(result.archivedAt, null);
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

scenario('未加载会话最后一轮已完成，仍不能以历史结果授权释放及归档', async () => {
  const store = storeFixture(), fixture = worktreeFixture(), id = threadFixture(fixture.target, 'notLoaded');
  conversations.delete(id);
  nativeFullThreads.set(id, {...nativeThreads.get(id), turns: [{status: 'completed', items: []}]});
  const {task} = makeTask(store, {threadId: id, deliveries: [deliveryFixture(1, 'MERGED', true, fixture.head)], worktrees: [fixture.worktree]});
  const result = await reconcile(store, task.id);
  assert.equal(result.cleanup.state, 'blocked'); assert(fs.existsSync(fixture.target));
  assert.equal(result.archivedAt, null); assert.equal(archived.length, 0);
  assert(!nativeReadCalls.some(call => call.includeTurns === true));
});

scenario('master 查询失败不否定已核实的 dev 合入，可释放干净工作区但不能归档', async () => {
  const store = storeFixture(), fixture = worktreeFixture();
  const delivery = deliveryFixture(1, 'MERGED', false, fixture.head);
  github.set('repos/fixture/workflow/compare/' + '1'.padStart(40, '0') + '...' + 'f'.repeat(40), Error('Fixture unavailable'));
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

scenario('远端工作区未确认回收时保持待收尾，确认 cleaned 后才归档', async () => {
  const store=storeFixture(), id=threadFixture(scenarioRoot);
  const remote={host:'bbdev',origin:'https://github.com/fixture/workflow.git',task:'fixture-owned',path:'/workspace/worktrees/fixture-owned/repo',branch:'feature/task',head:'b'.repeat(40),cleanup:{state:'retained',reason:'lease active',checkedAt:null}};
  const {task}=makeTask(store,{threadId:id,deliveries:[deliveryFixture(1,'MERGED',true)],remoteWorktrees:[remote]});
  process.env.WORKFLOW_FIXTURE_REMOTE_RESULT=JSON.stringify({worktrees:[remote]});
  let result=await reconcile(store,task.id);
  assert.equal(result.cleanup.state,'pending');assert.equal(result.archivedAt,null);assert.equal(archived.length,0);
  assert.equal(result.remoteWorktrees[0].cleanup.state,'retained');
  process.env.WORKFLOW_FIXTURE_REMOTE_RESULT=JSON.stringify({worktrees:[{...remote,cleanup:{state:'cleaned',reason:'',checkedAt:'2026-01-02T00:00:00Z'}}]});
  store.update(task.id,{remoteWorktreesSync:undefined});
  result=await reconcile(store,task.id);
  assert.equal(result.cleanup.state,'released');assert(result.archivedAt);assert.equal(archived.length,1);
  assert.equal(result.remoteWorktrees[0].cleanup.state,'cleaned');
});

scenario('远端读失败保留上次工作区，阻止把已到 master 的事项误判为全部收尾', async () => {
  const store=storeFixture(),id=threadFixture(scenarioRoot);
  const remote={host:'bbdev',origin:'https://github.com/fixture/workflow.git',task:'fixture-owned',path:'/workspace/worktrees/fixture-owned/repo',branch:'feature/task',head:'b'.repeat(40),cleanup:{state:'cleaned',reason:'',checkedAt:null}};
  const {task}=makeTask(store,{threadId:id,deliveries:[deliveryFixture(1,'MERGED',true)],remoteWorktrees:[remote]});
  process.env.WORKFLOW_FIXTURE_REMOTE_RESULT='fail';
  const result=await reconcile(store,task.id);
  assert.deepEqual(result.remoteWorktrees,[remote]);assert.match(result.remoteWorktreesSync.error,/尚未核对/);
  assert.equal(result.cleanup.state,'pending');assert.equal(result.archivedAt,null);assert.equal(archived.length,0);
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
  assert.deepEqual(helperCalls().map(call => call.desired), ['DONE']);
});

for (const isDraft of [false,true]) scenario(`HTTP 登记${isDraft?'草稿':'普通'} dev PR 后，即使仍在实现阶段也同步待测试并保存核验证据`, async () => {
  const app=require('fastify')(), id=threadFixture(scenarioRoot);
  const delivery=deliveryFixture(1,'OPEN');
  github.get('fixture/workflow#1').pr.isDraft=isDraft;
  try {
    await registerWorkflow(app);
    const service=JSON.parse(fs.readFileSync(path.join(process.env.CODEX_WORKFLOW_DATA,'service.json'),'utf8'));
    const attached=await app.inject({method:'POST',url:prefix+'/attach',headers:{authorization:'Bearer '+service.agentToken},payload:{threadId:id}});
    assert.equal(attached.statusCode,200,attached.body);
    const context=attached.json();
    const beforeReport=reconciliations.length;
    const response=await app.inject({method:'POST',url:prefix+'/'+context.workflowId+'/report',headers:{authorization:'Bearer '+context.token},
      payload:{stage:'implementation',issue:{number:110},deliveries:[delivery],summary:'Development PR created'}});
    assert.equal(response.statusCode,200,response.body);
    await waitForReconciliation(context.workflowId,beforeReport);
    const result=(await app.inject(prefix+'/'+context.workflowId)).json();
    assert.equal(result.mobius.status,'READY_FOR_TEST');
    assert.equal(result.stage,'implementation');assert.equal(result.deliveries[0].state,'OPEN');assert.equal(result.deliveries[0].isDraft,isDraft);
    assert(Number.isFinite(Date.parse(result.deliveries[0].checkedAt)));
    assert.equal(result.deliveries[0].devMergedAt,undefined);assert.equal(result.deliveries[0].masterMergedAt,undefined);
    assert.equal(result.cleanup.state,'none');assert.equal(result.archivedAt,null);assert.equal(archived.length,0);
    assert(githubCalls.some(args=>args[0]==='pr'&&args[6].split(',').includes('isDraft')));
  } finally {await app.close();}
});

for (const condition of ['closed','unavailable','incomplete','wrong-base']) scenario(`已登记 PR 的 ${condition} 证据不能由验收阶段推进 Möbius，也不能完成或归档`, async () => {
  const store=storeFixture(),id=threadFixture(scenarioRoot);
  const delivery=deliveryFixture(1,'OPEN');
  if(condition==='closed') github.get('fixture/workflow#1').pr.state='CLOSED';
  if(condition==='unavailable') github.set('fixture/workflow#1',{pr:Error('Fixture GitHub unavailable')});
  if(condition==='incomplete') delete github.get('fixture/workflow#1').pr.isDraft;
  if(condition==='wrong-base') github.get('fixture/workflow#1').pr.baseRefName='master';
  const {task}=makeTask(store,{threadId:id,stage:'verification',issue:{number:111,url:'https://issues.example.invalid/111'},
    deliveries:[{...delivery,devMergedAt:'2026-01-01T00:00:00Z',masterMergedAt:'2026-01-01T00:00:00Z'}]});
  const result=await reconcile(store,task.id);
  assert.equal(result.mobius.desired,null);assert.equal(result.mobius.status,'IN_PROGRESS');assert.equal(helperCalls().length,0);
  assert.equal(result.deliveries[0].devMergedAt,undefined);assert.equal(result.deliveries[0].masterMergedAt,undefined);
  assert(Number.isFinite(Date.parse(result.deliveries[0].checkedAt)));
  if(condition==='closed') assert.equal(result.deliveries[0].state,'CLOSED');
  else assert.match(result.deliveries[0].error,/暂时无法核对/);
  assert.equal(result.cleanup.state,'none');assert.equal(result.archivedAt,null);assert.equal(archived.length,0);
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
    const beforeReport=reconciliations.length;
    const report = await app.inject({method: 'POST', url: reportUrl, headers, payload: {stage: 'verification', issue: {number: 105}, summary: 'Ready for acceptance'}});
    assert.equal(report.statusCode, 200, report.body); assert.equal(report.json().managed, true);
    assert.equal(report.json().issue.url, 'https://issues.example.invalid/my-tasks?issue=105');
    await waitForReconciliation(context.workflowId,beforeReport);
    assert.equal((await app.inject(prefix+'/'+context.workflowId)).json().mobius.status,'READY_FOR_TEST');
    for (const action of ['refresh', context.workflowId + '/release', context.workflowId + '/archive']) {
      const denied = await app.inject({method: 'POST', url: prefix + '/' + action, headers: {origin: 'https://attacker.invalid'}});
      assert.equal(denied.statusCode, 403);
    }
    const callsBeforeRefresh = helperCalls().length;
    const beforeRefresh=reconciliations.length;
    const valid = await app.inject({method: 'POST', url: prefix + '/refresh', headers: {authorization: 'Bearer ' + service.agentToken}});
    assert.equal(valid.statusCode, 202); assert.equal(valid.json().syncing, true);
    await waitForReconciliation(context.workflowId,beforeRefresh);
    assert(helperCalls().length>callsBeforeRefresh);
    assert.equal((await app.inject(prefix+'/'+context.workflowId)).json().mobius.status,'READY_FOR_TEST');
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
    const beforeReport=reconciliations.length;
    const report = await app.inject({method: 'POST', url: prefix + '/' + context.workflowId + '/report',
      headers: {authorization: 'Bearer ' + context.token}, payload: {stage: 'done', status: 'completed',
        summary: 'Caller claims completion', issue: {number: 107}, deliveries: [delivery], worktrees: [fixture.worktree]}});
    if (report.statusCode === 400) {
      assert.match(report.body, /additional|properties|合入|字段/i, 'A strict schema may reject caller-supplied server facts');
    } else {
      assert.equal(report.statusCode, 200, report.body);
      await waitForReconciliation(context.workflowId,beforeReport);
      assert.equal((await app.inject(prefix+'/'+context.workflowId)).json().mobius.status,'READY_FOR_TEST');
    }
    const result = (await app.inject(prefix + '/' + context.workflowId)).json();
    assert.notEqual(result.mobius.status, 'DONE'); assert.equal(result.archivedAt, null);
    assert.equal(result.cleanup.state, 'none');
    assert(result.deliveries.every(item => !item.devMergedAt && !item.masterMergedAt));
    assert(fs.existsSync(fixture.target)); assert.equal(git(fixture.repo, 'rev-parse', 'feature-fixture'), fixture.head);
    assert.equal(archived.length, 0);
  } finally { await app.close(); }
});

scenario('HTTP 慢速 GitHub 核对不阻塞进度登记，旧核对不能覆盖新上报', async () => {
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
    const beforeReport=reconciliations.length;
    const first = await app.inject({method: 'POST', url, headers,
      payload: {stage: 'verification', issue: {number: 109}, deliveries: [{repo: delivery.repo, pr: delivery.pr, base: 'dev', release: 'master'}]}});
    assert.equal(first.statusCode, 200, first.body);
    const concurrent = await app.inject({method: 'POST', url, headers, payload: {deliveries: [], summary: 'Concurrent replacement'}});
    assert.equal(concurrent.statusCode, 200, concurrent.body);
    finishGithub();
    await waitForReconciliation(context.workflowId,beforeReport);
    await Promise.all(reconciliations.slice(beforeReport).map(item => item.operation));
    const observed = (await app.inject(prefix + '/' + context.workflowId)).json();
    assert.equal(observed.mobius.status,'READY_FOR_TEST');
    assert.equal(observed.deliveries.length, 0);
    assert.equal(observed.summary, 'Concurrent replacement');
  } finally { finishGithub?.(); await app.close(); }
});

scenario('手动归档清理已合入 dev 的导入事项，移除独立工作区且不改业务状态', async () => {
  const fixture = worktreeFixture(), store = storeFixture(), threadId = threadFixture(fixture.target, 'notLoaded');
  conversations.delete(threadId);
  const {task} = makeTask(store, {managed:false, imported:true, threadId, cwd:fixture.target,
    mobius:{status:'READY_FOR_RELEASE',desired:null,checkedAt:null,error:null},
    worktrees:[fixture.worktree], deliveries:[deliveryFixture(1,'MERGED',false,fixture.head)]});
  const lifecycle = new WorkflowLifecycle(store, scenarioRoot);
  const result = await lifecycle.archiveAndClean(task.id);
  assert(result.archivedAt); assert.equal(result.cleanup.state,'released');
  assert(!fs.existsSync(fixture.target)); assert(fs.existsSync(fixture.repo));
  assert.equal(fs.readFileSync(path.join(fixture.sibling,'personal.txt'),'utf8'),'preserve sibling data\n');
  assert.equal(git(fixture.repo,'for-each-ref','--format=%(refname)','refs/heads/feature-fixture'),'');
  assert.equal(result.managed,false); assert.equal(result.mobius.status,'READY_FOR_RELEASE');
  assert.equal(result.stage,task.stage); assert.equal(result.status,task.status);
  assert.equal(helperCalls().length,0,'Manual archive must not change Mobius');
  await lifecycle.archiveAndClean(task.id); assert.equal(archived.length,1);
});

for (const condition of ['unmerged','dirty','ignored','active','waiting','unknown']) scenario('手动归档清理保留工作区：'+condition, async () => {
  const fixture=worktreeFixture(), store=storeFixture();
  const runtime=condition==='active'||condition==='waiting'?'active':condition==='unknown'?'unknown':'idle';
  const threadId=threadFixture(fixture.target,runtime,condition==='waiting'?1:0);
  if(condition==='dirty')fs.appendFileSync(path.join(fixture.target,'tracked.txt'),'uncommitted\n');
  if(condition==='ignored')fs.writeFileSync(path.join(fixture.target,'ignored.log'),'personal evidence');
  const {task}=makeTask(store,{managed:false,threadId,cwd:fixture.target,worktrees:[fixture.worktree],
    deliveries:[deliveryFixture(1,condition==='unmerged'?'OPEN':'MERGED',false,fixture.head)]});
  const reason=condition==='unmerged'?/尚未全部合入/:condition==='dirty'||condition==='ignored'?/未提交、未跟踪或被忽略/:/运行或等待回应|状态尚未确认/;
  await assert.rejects(new WorkflowLifecycle(store,scenarioRoot).archiveAndClean(task.id),reason);
  assert(fs.existsSync(fixture.target)); assert.equal(git(fixture.repo,'rev-parse','feature-fixture'),fixture.head);
  assert.equal(store.get(task.id).archivedAt,null); assert.equal(archived.length,0);
});

scenario('手动归档接口核对来源并回读归档结果，失败可重试而不标记业务完成', async () => {
  const app=require('fastify')(); await app.register(registerWorkflow); await app.ready();
  const store=new WorkflowStore(process.env.CODEX_WORKFLOW_DATA); stores.add(store);
  const threadId=threadFixture(scenarioRoot,'notLoaded');
  const {task}=makeTask(store,{managed:false,threadId,deliveries:[deliveryFixture(1,'OPEN')]});
  const service=JSON.parse(fs.readFileSync(path.join(process.env.CODEX_WORKFLOW_DATA,'service.json'),'utf8'));
  const url=prefix+'/'+task.id+'/archive', headers={authorization:'Bearer '+service.agentToken};
  try {
    assert.equal((await app.inject({method:'POST',url,headers:{origin:'https://attacker.invalid'}})).statusCode,403);
    archiveMode='unconfirmed';
    const failed=await app.inject({method:'POST',url,headers});
    assert.equal(failed.statusCode,409); assert.match(failed.json().error,/归档结果尚未确认/);
    assert.equal(store.get(task.id).archivedAt,null);
    archiveMode='confirm';
    const result=await app.inject({method:'POST',url,headers});
    assert.equal(result.statusCode,200); assert(result.json().archivedAt);
    assert.equal(result.json().status,task.status); assert.equal(result.json().managed,false);
    assert.equal(helperCalls().length,0);
    assert.equal((await app.inject({method:'POST',url:prefix+'/'+randomUUID()+'/archive',headers})).statusCode,404);
  } finally {await app.close();}
});

scenario('手动归档等待远端回收确认，失败不归档并支持重新核对', async () => {
  const store=storeFixture(),threadId=threadFixture(scenarioRoot,'notLoaded');
  const remote={host:'bbdev',origin:'https://github.com/fixture/workflow.git',task:'fixture-owned',path:'/workspace/worktrees/fixture-owned/repo',branch:'feature/task',head:'b'.repeat(40),cleanup:{state:'retained',reason:'lease active',checkedAt:null}};
  const {task}=makeTask(store,{managed:false,threadId,remoteWorktrees:[remote]});
  const lifecycle=new WorkflowLifecycle(store,scenarioRoot);
  process.env.WORKFLOW_FIXTURE_REMOTE_RESULT=JSON.stringify({worktrees:[remote]});
  await assert.rejects(lifecycle.archiveAndClean(task.id),/^Error: lease active$/);
  assert.equal(store.get(task.id).archivedAt,null);assert.equal(archived.length,0);
  process.env.WORKFLOW_FIXTURE_REMOTE_RESULT='fail';
  await assert.rejects(lifecycle.archiveAndClean(task.id));
  assert.equal(store.get(task.id).archivedAt,null);assert.equal(archived.length,0);
  process.env.WORKFLOW_FIXTURE_REMOTE_RESULT=JSON.stringify({worktrees:[{...remote,cleanup:{state:'cleaned',reason:'',checkedAt:null}}]});
  const result=await lifecycle.archiveAndClean(task.id);
  assert(result.archivedAt);assert.equal(result.cleanup.state,'released');assert.equal(result.managed,false);
  assert.equal(archived.length,1);assert.equal(result.stage,task.stage);
});

scenario('手动归档保留其他空闲事项仍关联的工作区', async () => {
  const store=storeFixture(),fixture=worktreeFixture(),threadId=threadFixture(fixture.target);
  const {task}=makeTask(store,{managed:false,threadId,cwd:fixture.target,worktrees:[fixture.worktree],deliveries:[deliveryFixture(1,'MERGED',false,fixture.head)]});
  makeTask(store,{managed:false,threadId:threadFixture(fixture.target),cwd:fixture.target});
  await assert.rejects(new WorkflowLifecycle(store,scenarioRoot).archiveAndClean(task.id),/其他事项关联/);
  assert(fs.existsSync(fixture.target));assert.equal(git(fixture.repo,'rev-parse','feature-fixture'),fixture.head);
  assert.equal(archived.length,0);assert.equal(store.get(task.id).archivedAt,null);
});

scenario('未登记的远端工作区在释放测试资源前阻止归档，返回具体原因', async () => {
  const store=storeFixture(),threadId=threadFixture(scenarioRoot,'notLoaded');
  const remote={host:'bbdev',origin:'https://github.com/fixture/workflow.git',task:'fixture-owned',path:'/workspace/worktrees/fixture-owned/repo',branch:'feature/task',head:'b'.repeat(40),cleanup:{state:'unregistered',reason:'',checkedAt:null}};
  const {task}=makeTask(store,{managed:false,threadId,remoteWorktrees:[remote],resources:[{kind:'bbdev-lease',task:'fixture-owned',lease:'123456abcdef',released:false}]});
  process.env.WORKFLOW_FIXTURE_REMOTE_RESULT=JSON.stringify({worktrees:[remote]});
  await assert.rejects(new WorkflowLifecycle(store,scenarioRoot).archiveAndClean(task.id),/^Error: 远端工作区尚未登记回收，请先在对应会话完成交付并登记回收$/);
  assert.equal(helperCalls().length,0);assert.equal(store.get(task.id).resources[0].released,false);
  assert.equal(store.get(task.id).archivedAt,null);assert.equal(archived.length,0);
  assert.equal(store.get(task.id).error,store.get(task.id).cleanup.reason);
});

scenario('远端清理子进程拒绝时接口保留原因，不返回执行命令，失败后可以重试', async () => {
  const app=require('fastify')();await app.register(registerWorkflow);await app.ready();
  const store=new WorkflowStore(process.env.CODEX_WORKFLOW_DATA);stores.add(store);
  const threadId=threadFixture(scenarioRoot,'notLoaded');
  const remote={host:'bbdev',origin:'https://github.com/fixture/workflow.git',task:'fixture-owned',path:'/workspace/worktrees/fixture-owned/repo',branch:'feature/task',head:'b'.repeat(40),cleanup:{state:'registered',reason:'',checkedAt:null}};
  const {task}=makeTask(store,{managed:false,threadId,remoteWorktrees:[remote]});
  const service=JSON.parse(fs.readFileSync(path.join(process.env.CODEX_WORKFLOW_DATA,'service.json'),'utf8'));
  const request={method:'POST',url:prefix+'/'+task.id+'/archive',headers:{authorization:'Bearer '+service.agentToken}};
  process.env.WORKFLOW_FIXTURE_REMOTE_RESULT=JSON.stringify({worktrees:[remote]});
  process.env.WORKFLOW_FIXTURE_CLEANUP_ERROR='远端工作区的 Git 身份已变化，请重新核对登记';
  try {
    const response=await app.inject(request);
    assert.equal(response.statusCode,409);assert.equal(response.json().error,process.env.WORKFLOW_FIXTURE_CLEANUP_ERROR);
    assert.equal(store.get(task.id).error,response.json().error);assert.equal(store.get(task.id).archivedAt,null);assert.equal(archived.length,0);
    delete process.env.WORKFLOW_FIXTURE_CLEANUP_ERROR;
    process.env.WORKFLOW_FIXTURE_REMOTE_RESULT=JSON.stringify({worktrees:[{...remote,cleanup:{state:'cleaned',reason:'',checkedAt:null}}]});
    const retry=await app.inject(request);assert.equal(retry.statusCode,200);assert(retry.json().archivedAt);assert.equal(retry.json().error,null);
  } finally {delete process.env.WORKFLOW_FIXTURE_CLEANUP_ERROR;await app.close();}
});

async function waitForReconciliation(id, after) {
  const deadline=Date.now()+45000;
  let observed;
  while (!(observed=reconciliations.slice(after).find(item=>item.id===id))) {
    if(Date.now()>=deadline) throw Error('Lifecycle reconciliation did not start within 45000ms');
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  let timeout;
  try {
    await Promise.race([observed.operation,new Promise((_,reject)=>{
      timeout=setTimeout(()=>reject(Error('Lifecycle reconciliation did not finish within 45000ms')),Math.max(1,deadline-Date.now()));
    })]);
  } finally {clearTimeout(timeout);}
  console.log('Lifecycle completion observed:',Date.now()-observed.startedAt,'ms');
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
  const args=process.argv.slice(2);
  assert(args.length===0||args.length===2&&args[0]==='--match','Usage: node scripts/test-workflow-lifecycle.cjs [--match regex]');
  const pattern=args.length?new RegExp(args[1]):null;
  const selected=pattern?scenarios.filter(item=>pattern.test(item.name)):scenarios;
  assert(selected.length,'No workflow lifecycle scenarios matched');
  const temporaryParent = path.resolve('runtime/tmp');
  fs.mkdirSync(temporaryParent, {recursive: true});
  root = fs.mkdtempSync(path.join(temporaryParent, 'workflow-lifecycle-'));
  const helper = path.join(root, 'external-helper.py');
  fs.writeFileSync(helper, `import argparse,json,os,sys,time\np=argparse.ArgumentParser()\nfor key in ['number','desired','kind','task','lease','slot','expected-status','expected-prs']: p.add_argument('--'+key)\np.add_argument('--inspect',action='store_true')\na=vars(p.parse_args())\nwith open(os.environ['WORKFLOW_FIXTURE_CALLS'],'a',encoding='utf8') as f: f.write(json.dumps(a)+'\\n')\nif a['number']:\n time.sleep(float(os.environ.get('WORKFLOW_FIXTURE_MOBIUS_DELAY_MS','0'))/1000)\n if os.environ.get('WORKFLOW_FIXTURE_MOBIUS_FAIL') and (os.environ['WORKFLOW_FIXTURE_MOBIUS_FAIL']=='read' or not a['inspect']): sys.exit('Fixture Mobius unavailable')\n print(json.dumps({'number':int(a['number']),'title':'Fixture issue','isLeaf':True,'pullRequests':[], 'status':a['desired'] or os.environ['WORKFLOW_FIXTURE_MOBIUS_STATUS']}))\nelse: print(json.dumps({'released':os.environ['WORKFLOW_FIXTURE_RESOURCE_RELEASED']=='true','error':'Fixture lease still active'}))\n`);
  process.env.CODEX_WORKFLOW_MOBIUS_HELPER = helper;
  process.env.CODEX_WORKFLOW_RESOURCE_HELPER = helper;
  const remoteHelper=path.join(root,'remote-helper.py');
  fs.writeFileSync(remoteHelper,`import json,os,sys\nvalue=os.environ['WORKFLOW_FIXTURE_REMOTE_RESULT']\nif value=='fail':sys.exit(1)\nif json.loads(sys.argv[sys.argv.index('--request')+1]).get('cleanup') and os.environ.get('WORKFLOW_FIXTURE_CLEANUP_ERROR'):\n print(json.dumps({'error':os.environ['WORKFLOW_FIXTURE_CLEANUP_ERROR']}));sys.exit(1)\nprint(value)\n`);
  process.env.CODEX_WORKFLOW_REMOTE_WORKTREES_HELPER=remoteHelper;
  process.env.CODEX_WORKFLOW_PYTHON = process.env.CODEX_WORKFLOW_TEST_PYTHON || 'python';
  let failures = 0;
  try {
    for (const item of selected) {
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
  console.log(`PASS: ${selected.length} workflow lifecycle and HTTP business boundary scenarios`);
})().catch(error => { console.error(error); process.exitCode = 1; });
