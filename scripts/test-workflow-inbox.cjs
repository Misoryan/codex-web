const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const childProcess = require('node:child_process');
const {randomUUID} = require('node:crypto');
const {promisify} = require('node:util');
const ts = require('typescript');

// HTTP handlers, SQLite and the inbox execute unchanged; the external service and conversation host are fixtures.
const sourceRoot = path.resolve('src/server/workflow');
const modules = new Map();
const externalExecFile = (...args) => childProcess.execFile(...args);
externalExecFile[promisify.custom] = async (executable, args, options) => {
  if (executable === 'git') return promisify(childProcess.execFile)(executable, args, options);
  assert.equal(executable, 'workflow-inbox-fixture', 'Tests must never contact production helpers');
  if (args[2] === process.env.CODEX_WORKFLOW_REMOTE_WORKTREES_HELPER) {
    assert.equal(args[3], '--request');
    const request = JSON.parse(args[4]);
    const result = JSON.parse(fs.readFileSync(process.env.WORKFLOW_REMOTE_FIXTURE_RESPONSE, 'utf8'));
    if (result.fail) throw Error('Fixture remote unavailable');
    if (result.delay) await new Promise(resolve => setTimeout(resolve, result.delay));
    return {stdout: JSON.stringify(result.worktrees ? result : {worktrees: request.worktrees.map(item => ({...item,
      branch: 'fix/fixture', head: 'a'.repeat(40), cleanup: {state: 'unregistered', reason: '', checkedAt: null}}))}), stderr: ''};
  }
  if (args[2] === process.env.CODEX_WORKFLOW_MOBIUS_HELPER) {
    assert.deepEqual(args.slice(0, 2), ['-X', 'utf8']);
    return {stdout: JSON.stringify({status: 'IN_PROGRESS'}), stderr: ''};
  }
  assert.deepEqual(args, ['-X', 'utf8', process.env.CODEX_WORKFLOW_INBOX_HELPER]);
  const result = JSON.parse(fs.readFileSync(process.env.WORKFLOW_INBOX_FIXTURE_RESPONSE, 'utf8'));
  if (result.fail) throw Error('Fixture service unavailable');
  return {stdout: JSON.stringify(result), stderr: ''};
};
function load(name) {
  const file = path.join(sourceRoot, name + '.ts');
  if (modules.has(file)) return modules.get(file).exports;
  const item = new Module(file, module);
  item.filename = file;
  item.paths = Module._nodeModulePaths(path.dirname(file));
  const nativeRequire = item.require.bind(item);
  item.require = id => {
    if (id === 'node:child_process') return {...childProcess, execFile: externalExecFile};
    return id.startsWith('./') ? load(id.slice(2).replace(/\.js$/, '')) : nativeRequire(id);
  };
  modules.set(file, item);
  item._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
  }).outputText, file);
  return item.exports;
}
const {WorkflowStore} = load('store');
const {registerWorkflow} = load('routes');
const {refreshRemoteWorktrees} = load('remote-worktrees');
const prefix = '/__backend/workflow';
const environment = {...process.env}, previousHost = global.__codexWorkflowHost;
const temporaryParent = path.resolve('runtime/tmp');
fs.mkdirSync(temporaryParent, {recursive: true});
const root = fs.mkdtempSync(path.join(temporaryParent, 'workflow-inbox-'));
const helper = path.join(root, 'inbox-helper.py');
let serial = 0;
const issue = (number, patch = {}) => ({number, title: 'Assigned item ' + number,
  url: 'https://issues.example.invalid/my-tasks?issue=' + number, status: 'TODO', project: 'Fixture project',
  ancestors: [{number: 40, title: 'Fixture project', url: 'https://issues.example.invalid/my-tasks?issue=40'}], ...patch});

async function waitFor(read, message) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (await read()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw Error(message || 'Timed out waiting for the workflow response');
}

async function fixture(items, seed = () => {}) {
  const directory = path.join(root, 'case-' + ++serial), cwd = path.join(directory, 'EaseCationProjects');
  fs.mkdirSync(cwd, {recursive: true});
  const data = path.join(directory, 'data'), home = path.join(directory, 'home');
  fs.mkdirSync(home);
  const responseFile = path.join(directory, 'external-response.json');
  const remoteFile = path.join(directory, 'remote-response.json');
  const respondRemote = value => fs.writeFileSync(remoteFile, JSON.stringify(value));
  respondRemote({});
  const respond = value => fs.writeFileSync(responseFile, JSON.stringify(value));
  respond({items});
  Object.assign(process.env, {
    CODEX_HOME: home, CODEX_WORKFLOW_CWD: cwd, CODEX_WORKFLOW_DATA: data,
    CODEX_WORKFLOW_LOCAL_URL: 'http://workflow.example.invalid', CODEX_WORKFLOW_ORIGINS: '',
    CODEX_WORKFLOW_OBSERVER_IPC_URLS: '', CODEX_WORKFLOW_INBOX_HELPER: helper,
    CODEX_WORKFLOW_MOBIUS_HELPER: path.join(root, 'mobius-helper.py'),
    CODEX_WORKFLOW_ISSUE_URL: 'https://issues.example.invalid/my-tasks',
    CODEX_WORKFLOW_PYTHON: 'workflow-inbox-fixture',
    WORKFLOW_INBOX_FIXTURE_RESPONSE: responseFile,
    CODEX_WORKFLOW_REMOTE_WORKTREES_HELPER: path.join(root, 'remote-helper.py'), WORKFLOW_REMOTE_FIXTURE_RESPONSE: remoteFile,
  });
  const store = new WorkflowStore(data);
  seed(store, cwd);
  const starts = [], titles = [], metadata = [], rename = {mode: 'confirm'};
  const nativeThreads = new Map(store.list().filter(task => task.threadId).map(task =>
    [task.threadId, {id: task.threadId, name: task.title, cwd: task.cwd}]));
  const manager = {
    getConversation: () => undefined,
    async startConversation(input, options) {
      const id = randomUUID();
      starts.push({input, id});
      nativeThreads.set(id, {id, name: input.initialTitle, cwd: input.cwd});
      await options.afterConversationCreated(id);
      return {status: 'created', conversationId: id, firstTurn: {status: 'accepted'}};
    },
    async setThreadTitle(id, title) { titles.push({id, title}); },
  };
  const client = {
    registerInternalNotificationHandler: () => () => {},
    async sendAppServerRequest(method, params) {
      if (method === 'thread/loaded/list') return {data: [], nextCursor: null};
      assert.equal(method, 'thread/name/set', 'Metadata updates must never resume chats or send turns');
      assert(nativeThreads.has(params.threadId));
      metadata.push({method, params});
      if (rename.mode === 'throw') throw Error('Fixture name update unavailable');
      if (rename.mode === 'confirm') nativeThreads.get(params.threadId).name = params.name;
      return {};
    },
    async readThread(id, options) {
      assert.equal(options.includeTurns, false, 'Renaming must not load conversation turns');
      assert(nativeThreads.has(id));
      metadata.push({method: 'thread/read', params: {threadId: id, ...options}});
      return {...nativeThreads.get(id)};
    },
  };
  global.__codexWorkflowHost = {
    appServerManagersService: {}, hostAppServerManagers: {getCurrent: () => ({resource: {manager}})},
    getLocalAppServerClient: () => client,
    options: {globalState: {get(key) {
      assert.equal(key, 'local-projects');
      return {fixture: {id: 'fixture-project', rootPaths: [cwd]}};
    }}},
  };
  const app = require('fastify')();
  try {
    await registerWorkflow(app);
    await waitFor(async () => {
      const inbox = (await app.inject(prefix + '/inbox')).json();
      return inbox.checkedAt || inbox.error;
    }, 'Initial external inbox request did not settle');
  } catch (error) { await app.close(); store.close(); throw error; }
  const service = JSON.parse(fs.readFileSync(path.join(data, 'service.json'), 'utf8'));
  const headers = {authorization: 'Bearer ' + service.agentToken};
  const create = (number, patch = {}) => app.inject({method: 'POST', url: prefix, headers,
    payload: {requestKey: randomUUID(), title: 'Implement assigned item', kind: 'feature',
      prompt: 'Implement the existing requirement', ...(number === undefined ? {} : {issueNumber: number}), ...patch}});
  return {app, store, cwd, data, starts, titles, respond, respondRemote, create, metadata, nativeThreads, rename,
    async close() { await app.close(); store.close(); }};
}

const cases = [];
function scenario(name, run) { cases.push({name, run}); }

scenario('收集箱列出负责人尚无会话的事项，归档主关联和其他关联均去重', async () => {
  const first = issue(501), related = issue(502), pending = issue(503), nested = issue(504, {status: 'IN_PROGRESS'});
  const f = await fixture([first, related, pending, nested], (store, cwd) => {
    const archived = store.create('existing-archived', {title: 'Archived existing work', kind: 'fix', prompt: 'Existing requirement', cwd}).task;
    store.update(archived.id, {threadId: randomUUID(), issue: first, archivedAt: '2026-01-02T00:00:00.000Z'});
    const other = store.create('existing-related', {title: 'Related existing work', kind: 'fix', prompt: 'Existing related requirement', cwd}).task;
    store.update(other.id, {threadId: randomUUID(), relatedIssues: [related]});
  });
  try {
    const response = await f.app.inject(prefix + '/inbox');
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().items, [pending, nested]);
    assert(response.json().checkedAt); assert.equal(response.json().error, null);
    assert.equal(f.store.list().length, 2); assert.equal(f.starts.length, 0);
  } finally { await f.close(); }
});

scenario('HTTP schema 拒绝无效事项编号及请求字段，不建立会话或工作记录', async () => {
  const f = await fixture([issue(601)]);
  try {
    for (const number of [0, -1, 1.5, 100000001, 'invalid']) {
      const response = await f.create(number);
      assert.equal(response.statusCode, 400, response.body);
      assert.match(response.body, /issueNumber/);
    }
    for (const patch of [{requestKey: 'invalid'}, {title: ''}, {kind: 'unknown'}, {prompt: ''}]) {
      const response = await f.create(601, patch);
      assert.equal(response.statusCode, 400, response.body);
    }
    assert.equal(f.store.list().length, 0); assert.equal(f.starts.length, 0);
  } finally { await f.close(); }
});

scenario('同一事项的并发发起和重试只创建一个原生会话，保留原事项、项目和目录', async () => {
  const assigned = issue(701, {title: 'Existing feature', project: 'Existing Mobius project', status: 'IN_PROGRESS'});
  const f = await fixture([assigned]);
  try {
    const responses = await Promise.all([f.create(701), f.create(701)]);
    assert.deepEqual(responses.map(r => r.statusCode).sort(), [200, 202]);
    const id = responses[0].json().id;
    assert.equal(responses[1].json().id, id);
    await waitFor(() => f.store.get(id)?.status === 'running');
    const task = f.store.get(id);
    assert.equal(f.store.list().length, 1); assert.equal(f.starts.length, 1);
    assert.deepEqual(task.issue, assigned); assert.equal(task.project, assigned.project);
    assert.equal(task.cwd, f.cwd); assert.equal(task.workflowSource, 'workflow');
    assert.equal(task.title, '#701 Implement assigned item');
    assert.equal(task.mobius.status, 'IN_PROGRESS');
    assert.equal(task.threadId, f.starts[0].id);
    const started = f.starts[0].input;
    assert.equal(started.cwd, f.cwd); assert.deepEqual(started.workspaceRoots, [f.cwd]);
    assert.deepEqual(started.projectAssignment, {projectKind: 'local', projectId: 'fixture-project'});
    const prompt = started.input[0].text;
    assert(prompt.includes(assigned.url)); assert(prompt.includes('#701'));
    assert.match(prompt, /读取原事项需求并复用该事项/); assert.match(prompt, /\$easecation-workflow/);
    assert.match(prompt, /report-progress\.py/);
    assert.deepEqual(f.titles, [{id: task.threadId, title: task.title}]);
    const context = JSON.parse(fs.readFileSync(path.join(f.data, 'contexts', id + '.json'), 'utf8'));
    assert.equal(context.workflowId, id); assert(f.store.validToken(id, context.token));
    assert(!prompt.includes(context.token));
    f.respond({fail: true});
    const retry = await f.create(701, {title: 'Retry title'});
    assert.equal(retry.statusCode, 200); assert.equal(retry.json().threadId, task.threadId);
    assert.equal(f.starts.length, 1); assert.equal(f.store.list().length, 1);
    assert.deepEqual((await f.app.inject(prefix + '/inbox')).json().items, []);
  } finally { await f.close(); }
});

scenario('事项已完成或改负责人后不再位于外部待处理结果，拒绝从旧列表发起', async () => {
  const f = await fixture([issue(801), issue(802)]);
  try {
    f.respond({items: []});
    for (const number of [801, 802]) {
      const response = await f.create(number);
      assert.equal(response.statusCode, 409, response.body);
      assert.match(response.json().error, /已完成或已不由你负责/);
    }
    assert.equal(f.store.list().length, 0); assert.equal(f.starts.length, 0);
  } finally { await f.close(); }
});

scenario('外部服务失败或返回不完整数据时拒绝创建，保留错误供重新同步', async () => {
  const f = await fixture([issue(901)]);
  try {
    for (const result of [{fail: true}, {items: 'invalid'}, {items: [{number: 901}]}]) {
      f.respond(result);
      const response = await f.create(901);
      assert.equal(response.statusCode, 503, response.body);
      assert.match(response.json().error, /收集箱读取失败/);
      const inbox = (await f.app.inject(prefix + '/inbox')).json();
      assert.match(inbox.error, /重新同步/);
    }
    assert.equal(f.store.list().length, 0); assert.equal(f.starts.length, 0);
  } finally { await f.close(); }
});

scenario('未选择收集箱事项的普通创建不依赖外部服务，仍在配置项目目录启动', async () => {
  const f = await fixture([]);
  try {
    f.respond({fail: true});
    const response = await f.create(undefined, {kind: 'research', title: 'Independent research'});
    assert.equal(response.statusCode, 202, response.body);
    const id = response.json().id;
    await waitFor(() => f.store.get(id)?.status === 'running');
    const task = f.store.get(id);
    assert.equal(task.issue, null); assert.equal(task.cwd, f.cwd);
    assert.equal(f.starts.length, 1); assert.equal(f.store.list().length, 1);
    assert.equal(f.starts[0].input.cwd, f.cwd);
    assert.match(f.starts[0].input.input[0].text, /\$easecation-workflow/);
  } finally { await f.close(); }
});

for (const registered of [true, false]) scenario(`HTTP 标题上报为${registered ? '既有关联' : '首次登记'}事项同步编号和总结，原生元数据回读确认且不恢复会话`, async () => {
  const number = registered ? 105 : 106;
  let created;
  const f = await fixture([], (store, cwd) => {
    created = store.create('existing-report', {title: 'Earlier title', kind: 'fix', prompt: 'Existing requirement', cwd});
    store.update(created.task.id, {threadId: randomUUID(), ...(registered ? {issue: issue(number)} : {})});
  });
  try {
    if (registered) await waitFor(() => f.store.get(created.task.id).mobius.checkedAt);
    f.metadata.length = 0;
    const response = await f.app.inject({method: 'POST', url: prefix + '/' + created.task.id + '/report',
      headers: {authorization: 'Bearer ' + created.token},
      payload: {title: '#999 反馈 #88： 修复快捷入口', ...(registered ? {} : {issue: {number}})}});
    assert.equal(response.statusCode, 200, response.body);
    const expected = '#' + number + ' 修复快捷入口';
    const task = f.store.get(created.task.id);
    assert.equal(response.json().title, expected); assert.equal(task.title, expected);
    assert.equal(task.issue.number, number); assert.equal(task.managed, true);
    assert.equal(f.nativeThreads.get(task.threadId).name, expected);
    assert.deepEqual(f.metadata, [
      {method: 'thread/name/set', params: {threadId: task.threadId, name: expected}},
      {method: 'thread/read', params: {threadId: task.threadId, includeTurns: false}},
    ]);
    assert.equal(f.starts.length, 0, 'Reporting progress must not create or resume a conversation');
  } finally { await f.close(); }
});

scenario('原生标题写入失败或回读不一致时拒绝宣称更名成功，并保留工作流原标题', async () => {
  for (const mode of ['throw', 'unconfirmed']) {
    let created;
    const f = await fixture([], (store, cwd) => {
      created = store.create('rename-failure', {title: 'Original title', kind: 'fix', prompt: 'Existing requirement', cwd});
      store.update(created.task.id, {threadId: randomUUID()});
    });
    try {
      f.rename.mode = mode;
      const response = await f.app.inject({method: 'POST', url: prefix + '/' + created.task.id + '/report',
        headers: {authorization: 'Bearer ' + created.token}, payload: {title: 'Changed title', issue: {number: 107}}});
      assert.equal(response.statusCode, 503, response.body);
      assert.match(response.json().error, /标题更新未确认/);
      const task = f.store.get(created.task.id);
      assert.equal(task.title, 'Original title'); assert.equal(task.issue, null);
      assert.equal(f.nativeThreads.get(task.threadId).name, 'Original title');
      assert.equal(f.starts.length, 0);
      assert.equal(f.metadata[0].method, 'thread/name/set');
      assert.equal(f.metadata.length, mode === 'throw' ? 1 : 2);
    } finally { await f.close(); }
  }
});

scenario('本机工作区登记以 Git 为准，后续只上报摘要也刷新分支与 HEAD', async () => {
  let created;
  const f = await fixture([], (store, cwd) => {
    created = store.create('local-report', {title: 'Local work', kind: 'feature', prompt: 'Requirement', cwd});
  });
  const repo = path.join(f.cwd, 'primary'), target = path.join(f.cwd, 'task');
  fs.mkdirSync(repo);
  const git = (location, ...args) => childProcess.execFileSync('git', ['-C', location, ...args], {encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']}).trim();
  git(repo, 'init', '-b', 'dev');
  git(repo, 'config', 'user.name', 'Workflow Fixture'); git(repo, 'config', 'user.email', 'fixture@users.noreply.github.com');
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'base'); git(repo,'add','.'); git(repo,'commit','-m','Fixture base');
  git(repo,'worktree','add','-b','feature/task',target);
  const report = payload => f.app.inject({method:'POST',url:prefix+'/'+created.task.id+'/report',headers:{authorization:'Bearer '+created.token},payload});
  try {
    let response = await report({worktrees:[{repo,path:target,branch:'invented',head:'f'.repeat(40)}]});
    assert.equal(response.statusCode,200,response.body);
    assert.equal(response.json().worktrees[0].head,git(target,'rev-parse','HEAD'));
    assert.equal(response.json().worktrees[0].branch,'feature/task');
    git(target,'switch','-c','feature/updated');
    fs.writeFileSync(path.join(target,'tracked.txt'),'implemented'); git(target,'commit','-am','Fixture update');
    response = await report({summary:'Implementation progressed'});
    assert.equal(response.statusCode,200,response.body);
    assert.equal(response.json().worktrees[0].head,git(target,'rev-parse','HEAD'));
    assert.equal(response.json().worktrees[0].branch,'feature/updated');
    const before=f.store.get(created.task.id).worktrees;
    const rejected=await report({worktrees:[{repo,path:repo,branch:'dev',head:'f'.repeat(40)}]});
    assert.equal(rejected.statusCode,409);assert.match(rejected.json().error,/本机工作区登记未确认/);
    assert.deepEqual(f.store.get(created.task.id).worktrees,before);
    assert.equal(f.starts.length,0);
  } finally {await f.close();}
});

scenario('HTTP 立即登记远端工作区，分支和 HEAD 由只读工具回读，拒绝调用者伪造', async () => {
  let created;
  const f = await fixture([], (store, cwd) => {
    created = store.create('remote-report', {title: 'Remote work', kind: 'fix', prompt: 'Requirement', cwd});
  });
  const remote = {host: 'bbdev', task: 'fixture-owned', path: '/workspace/worktrees/fixture-owned/repo'};
  const report = payload => f.app.inject({method: 'POST', url: prefix + '/' + created.task.id + '/report',
    headers: {authorization: 'Bearer ' + created.token}, payload});
  try {
    const untrusted = await report({remoteWorktrees: [{...remote, head: 'b'.repeat(40)}]});
    assert.equal(untrusted.statusCode, 200);
    assert.equal(untrusted.json().remoteWorktrees[0].head, 'a'.repeat(40));
    const response = await report({remoteWorktrees: [remote], summary: 'Checkout prepared'});
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json().remoteWorktrees, [{...remote, branch: 'fix/fixture', head: 'a'.repeat(40),
      cleanup: {state: 'unregistered', reason: '', checkedAt: null}}]);
    assert.equal(response.json().remoteWorktreesSync.error, null);
    assert.equal(f.store.get(created.task.id).managed, true);
    assert.equal(f.store.get(created.task.id).worktrees.length, 0);
    assert.equal(f.starts.length, 0);
    f.respondRemote({fail: true});
    const failed = await report({remoteWorktrees: [{...remote, path: remote.path + '-new'}]});
    assert.equal(failed.statusCode, 503);
    assert.equal(f.store.get(created.task.id).remoteWorktrees[0].path, remote.path);
  } finally { await f.close(); }
});

scenario('HTTP 接受真实待回收状态 eligible 和 eligible_resume，拒绝未知状态且保留登记', async () => {
  let created;
  const f=await fixture([], (store,cwd)=>{
    created=store.create('remote-eligible',{title:'Remote cleanup',kind:'feature',prompt:'Requirement',cwd});
  });
  const remote={host:'bbdev',task:'fixture-owned',path:'/workspace/worktrees/owned/repo'};
  const report=()=>f.app.inject({method:'POST',url:prefix+'/'+created.task.id+'/report',headers:{authorization:'Bearer '+created.token},payload:{remoteWorktrees:[remote]}});
  try {
    for(const state of ['eligible','eligible_resume']) {
      f.respondRemote({worktrees:[{...remote,branch:'feature/owned',head:'a'.repeat(40),cleanup:{state,reason:'Awaiting existing cleanup worker',checkedAt:null}}]});
      const response=await report();
      assert.equal(response.statusCode,200,response.body);
      assert.equal(response.json().remoteWorktrees[0].cleanup.state,state);
      assert.notEqual(response.json().cleanup.state,'released');
    }
    const before=f.store.get(created.task.id).remoteWorktrees;
    f.respondRemote({worktrees:[{...remote,branch:'feature/owned',head:'a'.repeat(40),cleanup:{state:'unknown-cleanup-state',reason:'',checkedAt:null}}]});
    const response=await report();
    assert.equal(response.statusCode,503,response.body);
    assert.match(response.json().error,/登记未确认/);
    assert.deepEqual(f.store.get(created.task.id).remoteWorktrees,before);
  } finally {await f.close();}
});

scenario('远端核对未完成时 GET 列表仍立即返回已登记数据，缺失与跨任务返回不覆盖记录', async () => {
  let created;
  const f = await fixture([], (store, cwd) => {
    created = store.create('remote-slow', {title: 'Remote work', kind: 'fix', prompt: 'Requirement', cwd});
  });
  const remote = {host: 'bbdev', task: 'fixture-owned', path: '/workspace/worktrees/fixture-owned/repo'};
  const report = () => f.app.inject({method: 'POST', url: prefix + '/' + created.task.id + '/report',
    headers: {authorization: 'Bearer ' + created.token}, payload: {remoteWorktrees: [remote]}});
  try {
    f.respondRemote({delay: 700});
    const pending = report();
    const result = await Promise.race([f.app.inject(prefix), new Promise((_, reject) => setTimeout(() => reject(Error('List waited for SSH')), 400))]);
    assert.equal(result.statusCode, 200);
    assert.equal((await pending).statusCode, 200);
    for (const worktrees of [[], [{...remote, task: 'another-task', branch: 'fix/fixture', head: 'a'.repeat(40),
      cleanup: {state: 'cleaned', reason: '', checkedAt: null}}]]) {
      f.respondRemote({worktrees});
      assert.equal((await report()).statusCode, 503);
      assert.equal(f.store.get(created.task.id).remoteWorktrees[0].task, remote.task);
    }
  } finally { await f.close(); }
});

scenario('较早的远端后台核对不能覆盖同时成功的新工作区登记', async () => {
  let created;
  const old={host:'bbdev',task:'fixture-owned',path:'/workspace/worktrees/old/repo',branch:'fix/old',head:'a'.repeat(40),cleanup:{state:'retained',reason:'',checkedAt:null}};
  const f=await fixture([], (store,cwd)=>{
    created=store.create('remote-race',{title:'Remote progress',kind:'feature',prompt:'Requirement',cwd});
    store.update(created.task.id,{remoteWorktrees:[old]});
  });
  try {
    f.store.update(created.task.id,{remoteWorktreesSync:undefined});
    f.respondRemote({delay:700,worktrees:[old]});
    const pending=refreshRemoteWorktrees(f.store,created.task.id);
    const added={host:'bbdev',task:'fixture-owned',path:'/workspace/worktrees/new/repo'};
    f.respondRemote({});
    const response=await f.app.inject({method:'POST',url:prefix+'/'+created.task.id+'/report',headers:{authorization:'Bearer '+created.token},
      payload:{remoteWorktrees:[{host:old.host,task:old.task,path:old.path},added]}});
    assert.equal(response.statusCode,200,response.body);
    assert.equal(response.json().remoteWorktrees.length,2);
    await pending;
    assert.deepEqual(f.store.get(created.task.id).remoteWorktrees.map(item=>item.path),[old.path,added.path]);
  } finally {await f.close();}
});

function cleanup() {
  assert.equal(path.dirname(root), temporaryParent);
  assert(path.basename(root).startsWith('workflow-inbox-'));
  assert.equal(fs.realpathSync(root).toLowerCase(), root.toLowerCase());
  if (process.platform === 'win32') {
    const script = "$taskFixture = Get-Item -LiteralPath '" + root.replace(/'/g, "''") + "'; " +
      "$taskAttributes = [IO.FileAttributes]::ReadOnly -bor [IO.FileAttributes]::Hidden; " +
      "Get-ChildItem -LiteralPath $taskFixture.FullName -Recurse -Force | ForEach-Object { $_.Attributes = $_.Attributes -band (-bnot $taskAttributes) }; " +
      "$taskFixture.Attributes = $taskFixture.Attributes -band (-bnot $taskAttributes); " +
      "Remove-Item -LiteralPath $taskFixture.FullName -Recurse -ErrorAction Stop";
    childProcess.execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {windowsHide: true, stdio: 'pipe'});
  } else fs.rmSync(root, {recursive: true});
}

(async () => {
  let failures = 0;
  try {
    for (const item of cases) {
      try { await item.run(); console.log('PASS:', item.name); }
      catch (error) { failures++; console.error('FAIL:', item.name); console.error(error); }
    }
  } finally {
    global.__codexWorkflowHost = previousHost;
    for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key];
    Object.assign(process.env, environment);
    cleanup();
  }
  assert.equal(failures, 0, `${failures} workflow inbox scenarios failed`);
  console.log(`PASS: ${cases.length} workflow inbox HTTP and SQLite business boundary scenarios`);
})().catch(error => { console.error(error); process.exitCode = 1; });
