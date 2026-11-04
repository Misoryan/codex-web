import assert from 'node:assert/strict';
import {createHash, randomBytes} from 'node:crypto';
import {copyFile, mkdir, mkdtemp, readFile, symlink, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {AssistantState} from '../ops/machine-state.mjs';
import {createMachineApi} from '../ops/machine-api.mjs';

// Run the actual local state/ticket commands against an isolated state root.
// Required test environment paths name installed scripts, never user request data.
const stateScript = process.env.CODEX_API_TEST_STATE_SCRIPT;
const pythonScript = process.env.CODEX_API_TEST_PYTHON_SCRIPT;
const ticketSource = process.env.CODEX_API_TEST_TICKET_SCRIPT;
const pwsh = process.env.CODEX_API_TEST_PWSH;
if (![stateScript, pythonScript, ticketSource, pwsh].every(Boolean)) throw Error('Configure the four CODEX_API_TEST_* script paths');
const root = await mkdtemp(path.resolve('runtime/tmp/machine-state-'));
for (const directory of ['memory/views/grokbot', 'memory/views/ec-feedback', 'handoff', 'tickets', 'events', 'secrets', 'outside'])
  await mkdir(path.join(root, directory), {recursive: true});
await copyFile(ticketSource, path.join(root, 'tickets/ticket.py'));
await writeFile(path.join(root, 'memory/changes.jsonl'), '');
await writeFile(path.join(root, 'memory/views/grokbot/MEMORY.md'), 'fixture main memory');
await writeFile(path.join(root, 'memory/views/ec-feedback/MEMORY.md'), 'fixture feedback memory');
await writeFile(path.join(root, 'memory/grokbot-delta-20260101.md'), 'fixture daily delta');
await writeFile(path.join(root, 'handoff/grokbot.json'), '{"summary":"fixture handoff"}');
await writeFile(path.join(root, '待你处理.md'), 'fixture pending');
await writeFile(path.join(root, 'secrets/secret.txt'), 'must never escape');
const row = {id: 'fixture-ticket', title: 'Fixture title', refs: {issues: [], feedback: [], prs: [], codex_threads: [], feishu: []},
  stage: 'idle', waiting_on: '', last_event: {at: '2026-01-01T00:00:00+08:00', summary: 'Before'}, feishu_cursor: {}, updated_at: '2026-01-01T00:00:00+08:00'};
await writeFile(path.join(root, 'tickets/ledger.json'), JSON.stringify([row]));
const token = randomBytes(32).toString('base64url'), hashFile = path.join(root, 'secrets/hash');
await writeFile(hashFile, createHash('sha256').update(token).digest('hex'));
const state = new AssistantState({root, pwsh, stateScript, pythonScript, ticketScript: path.join(root, 'tickets/ticket.py')});
const app = await createMachineApi({bridge: {close() {}}, tokenHashFile: hashFile, state});
const call = (method, url, payload, auth = true) => app.inject({method, url: '/codex/api/v1/state' + url,
  headers: auth ? {authorization: 'Bearer ' + token} : {}, ...(payload === undefined ? {} : {payload})});
try {
  assert.equal((await call('GET', '/files', undefined, false)).statusCode, 401);
  const files = (await call('GET', '/files')).json().files.map(file => file.path);
  assert.deepEqual(files.sort(), ['memory/views/grokbot/MEMORY.md', 'memory/views/ec-feedback/MEMORY.md',
    'memory/grokbot-delta-20260101.md', 'handoff/grokbot.json', '待你处理.md'].sort());
  for (const file of files) {
    const response = await call('GET', '/file?path=' + encodeURIComponent(file));
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().content, await readFile(path.join(root, file), 'utf8'));
  }
  for (const file of ['secrets/secret.txt', '../secrets/secret.txt', 'handoff/../secrets/secret.txt',
    'memory\\views\\grokbot\\MEMORY.md', '/memory/views/grokbot/MEMORY.md',
    'memory/views/grokbot/MEMORY.md:secret', 'memory/%2e%2e/secrets/secret.txt', 'tickets/ledger.json'])
    assert.equal((await call('GET', '/file?path=' + encodeURIComponent(file))).statusCode, 403, file);
  await symlink(path.join(root, 'outside'), path.join(root, 'handoff/linked.json'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await call('GET', '/file?path=handoff%2Flinked.json')).statusCode, 403);
  const before = await readFile(path.join(root, 'memory/changes.jsonl'), 'utf8');
  for (const body of [{profile: 'other', text: 'forbidden'}, {profile: 'grokbot', text: 'bad\nline'},
    {profile: 'grokbot', text: 'forbidden', source: 'hermes'}, {profile: 'grokbot', text: 'x'.repeat(70000)}])
    assert.ok([400, 413].includes((await call('POST', '/memory', body)).statusCode));
  assert.equal(await readFile(path.join(root, 'memory/changes.jsonl'), 'utf8'), before);
  for (const profile of ['grokbot', 'ec-feedback']) {
    const value = 'API参数保持原文："quoted" $() ` --root=forbidden & ; 中文';
    const put = await call('POST', '/memory', {profile, text: value});
    assert.equal(put.statusCode, 200, put.body);
    assert.equal(put.json().source, 'dots');
    assert.equal(put.json().text, value);
    assert.equal((await call('GET', '/file?path=' + encodeURIComponent(`memory/views/${profile}/MEMORY.md`))).json().content, value + '\n');
  }
  assert.match((await call('GET', '/tickets?open=true')).json().text, /fixture-ticket\tidle\tFixture title/);
  assert.deepEqual((await call('GET', '/tickets/fixture-ticket')).json().ticket, row);
  const updated = await call('POST', '/tickets/fixture-ticket', {stage: 'working', waiting_on: '"引号" $() --root=outside', last_event: {summary: '真实脚本更新'}});
  assert.equal(updated.statusCode, 200, updated.body);
  assert.equal(updated.json().ticket.stage, 'working');
  assert.equal(updated.json().ticket.title, row.title);
  assert.equal(updated.json().ticket.waiting_on, '"引号" $() --root=outside');
  assert.equal(updated.json().ticket.last_event.summary, '真实脚本更新');
  assert.notEqual(updated.json().ticket.last_event.at, row.last_event.at);
  const ledger = await readFile(path.join(root, 'tickets/ledger.json'), 'utf8');
  for (const payload of [{refs: {issues: [1]}}, {title: 'not allowed'}, {stage: 'merged'},
    {last_event: {summary: 'x', at: 'forged'}}, {cmd: 'delete'}, {}])
    assert.equal((await call('POST', '/tickets/fixture-ticket', payload)).statusCode, 400);
  assert.equal((await call('POST', '/tickets/unknown-ticket', {stage: 'ended'})).statusCode, 502);
  assert.equal(await readFile(path.join(root, 'tickets/ledger.json'), 'utf8'), ledger);
  const audit = (await readFile(path.join(root, 'events/dots-api-audit.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(audit.filter(entry => entry.status === 'succeeded').length, 3);
  assert.ok(audit.every(entry => entry.time && entry.api && entry.summary && entry.source === 'dots'));
  assert.ok(!JSON.stringify(audit).includes(token));
  console.log('PASS: real state and ticket scripts, Chinese/quoted arguments, both profiles, fixed file allowlist, traversal/link/secret rejection, restricted updates, body limit and audit');
} finally {
  await app.close();
  console.log('Task fixture to remove: ' + root);
}
