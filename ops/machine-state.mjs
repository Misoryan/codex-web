import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {appendFile, lstat, open, readdir, realpath} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';

const execute = promisify(execFile);
const problem = (statusCode, message) => Object.assign(Error(message), {statusCode});
const allowed = name => [
  'memory/views/grokbot/MEMORY.md', 'memory/views/ec-feedback/MEMORY.md', '待你处理.md',
].includes(name) || /^memory\/grokbot-delta-[A-Za-z0-9_-]+\.md$/.test(name) || /^handoff\/[A-Za-z0-9_-]+\.json$/.test(name);
const stages = ['working', 'waiting_user_answer', 'waiting_user_review', 'waiting_other_person', 'blocked', 'failed', 'idle', 'ended'];
const text = {type: 'string', minLength: 1, maxLength: 4000};
const object = (properties, required = []) => ({type: 'object', additionalProperties: false, properties, required});

export class AssistantState {
  constructor({root, pwsh, stateScript, pythonScript, ticketScript}) {
    if (![root, pwsh, stateScript, pythonScript, ticketScript].every(value => typeof value === 'string' && path.isAbsolute(value)))
      throw Error('State service requires fixed absolute server paths');
    this.root = path.resolve(root);
    this.pwsh = pwsh;
    this.stateScript = stateScript;
    this.pythonScript = pythonScript;
    this.ticketScript = ticketScript;
  }

  async safe(name, missing = false) {
    if (await realpath(this.root) !== this.root) throw problem(403, 'State root must not be a link');
    let target = this.root;
    for (const segment of name.split('/')) {
      if (!segment || segment === '.' || segment === '..' || /[\\:%\0]/.test(segment)) throw problem(403, 'Path is not allowed');
      target = path.join(target, segment);
      try {
        if ((await lstat(target)).isSymbolicLink()) throw problem(403, 'Links are not allowed');
      } catch (error) { if (missing && error.code === 'ENOENT') continue; throw error; }
    }
    return target;
  }

  async files() {
    const names = ['memory/views/grokbot/MEMORY.md', 'memory/views/ec-feedback/MEMORY.md', '待你处理.md'];
    for (const folder of ['memory', 'handoff']) {
      const directory = await this.safe(folder);
      for (const entry of await readdir(directory, {withFileTypes: true})) {
        const name = `${folder}/${entry.name}`;
        if (entry.isFile() && allowed(name)) names.push(name);
      }
    }
    const files = [];
    for (const name of names) {
      try {
        const file = await this.safe(name), stat = await lstat(file);
        if (stat.isFile()) files.push({path: name, bytes: stat.size, modifiedAt: stat.mtime.toISOString()});
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return {files};
  }

  async read(name) {
    if (!allowed(name)) throw problem(403, 'Path is not allowed');
    let handle;
    try {
      handle = await open(await this.safe(name), 'r');
      const stat = await handle.stat();
      if (!stat.isFile()) throw problem(403, 'Only regular files are allowed');
      if (stat.size > 2 * 1024 * 1024) throw problem(413, 'State file exceeds 2 MiB');
      const content = await handle.readFile('utf8');
      if (Buffer.byteLength(content) > 2 * 1024 * 1024) throw problem(413, 'State file exceeds 2 MiB');
      return {path: name, modifiedAt: stat.mtime.toISOString(), content: content.replace(/^\uFEFF/, '')};
    } catch (error) { if (error.code === 'ENOENT') throw problem(404, 'State file not found'); throw error; }
    finally { await handle?.close(); }
  }

  async run(script, args) {
    try {
      const {stdout} = await execute(this.pwsh, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script, ...args], {
        shell: false, windowsHide: true, timeout: 30000, maxBuffer: 2 * 1024 * 1024, cwd: this.root,
        env: {...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', ASSISTANT_STATE_ROOT: this.root, TICKETS_DIR: path.join(this.root, 'tickets')},
      });
      return stdout.replace(/^\uFEFF/, '').trim();
    } catch { throw problem(502, 'State command failed; inspect the local service'); }
  }

  async audit(api, summary, work) {
    const file = await this.safe('events/dots-api-audit.jsonl', true);
    const write = status => appendFile(file, JSON.stringify({time: new Date().toISOString(), api, source: 'dots', summary, status}) + '\n', {encoding: 'utf8', mode: 0o600});
    await write('requested');
    try { const result = await work(); await write('succeeded'); return result; }
    catch (error) { await write('failed'); throw error; }
  }

  async putMemory({profile, text: value}) {
    if (!value.trim() || /[\r\n\0]/.test(value)) throw problem(400, 'Memory must contain one nonempty line');
    for (const name of ['.state.lock', 'memory/changes.jsonl', 'memory/views/grokbot/MEMORY.md', 'memory/views/ec-feedback/MEMORY.md']) await this.safe(name, true);
    return this.audit('POST /state/memory', {profile, characters: value.length, sha256: createHash('sha256').update(value).digest('hex')}, async () =>
      JSON.parse(await this.run(this.stateScript, ['put', '--profile', profile, '--source', 'dots', '--text=' + value])));
  }

  async ticketArgs() {
    for (const name of ['tickets/ledger.json', 'tickets/ledger.lock']) await this.safe(name, true);
    if (await realpath(this.ticketScript) !== await this.safe('tickets/ticket.py')) throw problem(403, 'Ticket script must be the fixed state script');
    return [this.ticketScript];
  }
  async listTickets(onlyOpen) {
    return {text: await this.run(this.pythonScript, [...await this.ticketArgs(), 'list', ...(onlyOpen ? ['--open'] : [])])};
  }
  async ticket(id) {
    const value = await this.run(this.pythonScript, [...await this.ticketArgs(), 'show', id]);
    return {ticket: JSON.parse(value)};
  }
  async updateTicket(id, body) {
    if (!Object.keys(body).length) throw problem(400, 'At least one update field is required');
    await this.ticket(id); // Public updates cannot create or rename tickets.
    const partial = {...body};
    if (body.last_event) partial.last_event = {at: new Date().toISOString(), summary: body.last_event.summary};
    return this.audit('POST /state/tickets/:id', {id, fields: Object.keys(body), ...(body.stage ? {stage: body.stage} : {})}, async () => {
      await this.run(this.pythonScript, [...await this.ticketArgs(), 'upsert', id, '--json', JSON.stringify(partial)]);
      return this.ticket(id);
    });
  }
}

export function registerStateRoutes(app, state) {
  const root = '/codex/api/v1/state';
  const idParams = object({id: {type: 'string', pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$', maxLength: 160}}, ['id']);
  app.get(root + '/files', {schema: {querystring: object({})}}, () => state.files());
  app.get(root + '/file', {schema: {querystring: object({path: text}, ['path'])}}, request => state.read(request.query.path));
  app.post(root + '/memory', {schema: {body: object({profile: {type: 'string', enum: ['grokbot', 'ec-feedback']}, text}, ['profile', 'text'])}}, request => state.putMemory(request.body));
  app.get(root + '/tickets', {schema: {querystring: object({open: {type: 'boolean'}})}}, request => state.listTickets(request.query.open));
  app.get(root + '/tickets/:id', {schema: {params: idParams, querystring: object({})}}, request => state.ticket(request.params.id));
  app.post(root + '/tickets/:id', {schema: {params: idParams, body: object({
    stage: {type: 'string', enum: stages}, waiting_on: {type: 'string', maxLength: 4000},
    last_event: object({summary: text}, ['summary']),
  })}}, request => state.updateTicket(request.params.id, request.body));
}
