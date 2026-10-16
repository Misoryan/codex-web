import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {brotliCompressSync, gzipSync, constants} from 'node:zlib';
import ts from 'typescript';
import {patchSubagentInheritance} from './subagent-inheritance-patch.mjs';

const helper = await fs.readFile(new URL('../src/browser/subagent-history.js', import.meta.url), 'utf8');
const initial = 'app-shared-8bd9d0399038.js';
const panel = 'open-local-conversation-subagents-panel-5abfac9190b9.js';
const verify = 'verify-descendant-d02f27822163.js';

function once(source, pattern, replacement, label) {
  const count = typeof pattern === 'string' ? source.split(pattern).length - 1 : [...source.matchAll(pattern)].length;
  if (count !== 1) throw Error(`Subagent history anchor changed: ${label} (${count})`);
  return source.replace(pattern, replacement);
}

function parse(source) {
  return ts.createSourceFile('bundle.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
}

function nodes(file, predicate) {
  const matches = [];
  function visit(node) {
    if (predicate(node)) matches.push(node);
    ts.forEachChild(node, visit);
  }
  visit(file);
  return matches;
}

function exactly(values, label) {
  if (values.length !== 1) throw Error(`Subagent history node changed: ${label} (${values.length})`);
  return values[0];
}

export function patchSubagentHistory(source) {
  if (source.includes('codexWebReadSubagentPreview(this')) return source;
  const file=parse(source),edits=[];
  const functions=nodes(file,ts.isFunctionDeclaration);
  const methods=nodes(file,ts.isMethodDeclaration);
  const method=(name,needle)=>exactly(methods.filter(n=>n.name.getText(file)===name&&n.getText(file).includes(needle)),name);
  const edit=(node,text)=>edits.push({start:node.getStart(file),end:node.end,text});
  const background=method('hydrateBackgroundThreads','this.hydrateThreads');
  let body=background.getText(file);
  body=once(body,'refreshExisting: r = !1','refreshExisting: r = !1, subagentPreview: codexWebPreview = false','background option');
  body=once(body,'includeTurns: t,','includeTurns: t, subagentPreview: codexWebPreview,','background forwarding');
  edit(background,body);
  const hydrate=method('hydrateThreads','upsertHydratedConversationState');
  body=hydrate.getText(file);
  body=once(body,'requestOptions: d,','requestOptions: d, subagentPreview: codexWebPreview = false,','hydrate option');
  body=once(body,'readThread: (e, t) => (','readThread: (e, t) => codexWebPreview ? codexWebReadSubagentPreview(this,e) : (','preview read');
  body=once(body,'let l = n != null || s ? t.turnsPagination : void 0,','let l = codexWebPreview || n != null || s ? t.turnsPagination : void 0,','preview cursor');
  body=once(body,'u =\n                  n == null &&','u = codexWebPreview ? t.preserveHistory :\n                  n == null &&','preserve loaded history');
  body=once(body,'!r || u)','codexWebPreview && codexWebApplySubagentPreviewState(this,e,t), !r || u)','preview state');
  body=once(body,'((n != null || s || a == null ? rh : nh)(','((codexWebPreview || n != null || s || a == null ? rh : nh)(','keep loaded history');
  edit(hydrate,body);
  const manager=method('hydrateBackgroundThreads','this.threadStore.hydrateBackgroundThreads');
  edit(manager,manager.getText(file)+'\nhasLoadedSubagentHistory(threadId) {return codexWebHasSubagentHistory(this.getConversation(threadId));}');
  const setter=method('setConversation','this.conversations.get(');
  const first=setter.body.statements[0],declarations=first.declarationList.declarations;
  if(declarations.length!==3)throw Error('Conversation snapshot changed');
  const previous=declarations[0].name.getText(file),incoming=declarations[2].name.getText(file);
  body=setter.getText(file);const at=first.end-setter.getStart(file);
  body=body.slice(0,at)+`\nif(${previous}?.codexWebSubagentPreview===true){if(!Object.hasOwn(${incoming},'codexWebSubagentPreview'))${incoming}.codexWebSubagentPreview=true;if(!Object.hasOwn(${incoming},'codexWebParentTurnIds'))${incoming}.codexWebParentTurnIds=${previous}.codexWebParentTurnIds;}\n`+body.slice(at);edit(setter,body);
  const loader=exactly(functions.filter(n=>n.getText(file).includes('thread/items/list repeated cursor')),'page loader');
  const parent=exactly(functions.filter(n=>n.name?.text==='GB'&&n.getText(file).includes('parentThreadId')),'parent thread');
  const placeholder=exactly(functions.filter(n=>n.body&&n.body.getText(file).length<400&&/\.turnStartedAtMs\s*==\s*null/.test(n.getText(file))&&/\.items\.length\s*===\s*0/.test(n.getText(file))),'placeholder turn');
  for(const e of edits.sort((a,b)=>b.start-a.start))source=source.slice(0,e.start)+e.text+source.slice(e.end);
  source+='\n'+helper.replaceAll('__CODEX_WEB_PAGE_LOADER__',loader.name.text).replaceAll('__CODEX_WEB_MERGE_POLICY__','wz').replaceAll('__CODEX_WEB_PARENT_THREAD__',parent.name.text).replaceAll('__CODEX_WEB_LOADED_TURNS__','mz').replaceAll('__CODEX_WEB_PLACEHOLDER_TURN__',placeholder.name.text);
  return source;
}
export function patchSubagentVerification(source) {
  if(!/includeTurns:\s*!1/.test(source))throw Error('Native metadata ancestry changed');
  return source;
}
export function patchSubagentPanel(source) {
  if(source.includes('subagentPreview:true'))return source;
  const file=parse(source);
  const parentReads=nodes(file,n=>ts.isIfStatement(n)&&n.expression.getText(file).replace(/\s+/g,'')==='D&&N?.forkedFromId!==null');
  const parentRead=exactly(parentReads,'parent history read');
  source=source.slice(0,parentRead.getStart(file))+source.slice(parentRead.end);
  source=once(source,/D\s*=\s*g\s*!=\s*null\s*&&\s*!T\s*&&\s*E\s*!==\s*!0/g,'D=g!=null&&!u(e,i).hasLoadedSubagentHistory(g)','child history state');
  return once(source,/u\(e,\s*i\)\s*\.loadBackgroundThreadHistoryPage\(g\)/g,'u(e,i).hydrateBackgroundThreads([g],{includeTurns:true,maxTurns:5,subagentPreview:true,refreshExisting:true})','child preview');
}

export const patches = [[initial, patchSubagentHistory], [panel, patchSubagentPanel], [verify, patchSubagentVerification]];
const hash = data => createHash('sha256').update(data).digest('hex');

export async function stageSubagentHistory(baseline, stage) {
  const files = [];
  async function save(file, data) {
    const before = await fs.readFile(path.join(baseline, file));
    for (const [folder, content] of [['before', before], ['app', data]]) {
      const target = path.join(stage, folder, file);
      await fs.mkdir(path.dirname(target), {recursive: true});
      await fs.writeFile(target, content);
    }
    files.push({file, before: hash(before), sha256: hash(data)});
  }
  for (const prefix of ['', 'lite/']) for (const [name, patch] of patches) {
    const file = prefix + 'assets/' + name;
    const data = Buffer.from(patch(await fs.readFile(path.join(baseline, file), 'utf8')));
    await save(file, data);
    for (const [ext, compress] of [['.br', b => brotliCompressSync(b, {params: {[constants.BROTLI_PARAM_QUALITY]: 4}})], ['.gz', gzipSync]]) {
      try {await fs.access(path.join(baseline, file + ext));} catch {continue;}
      await save(file + ext, compress(data));
    }
  }
  let worker = await fs.readFile(path.join(baseline, 'lite/sw.js'), 'utf8');
  const marker = worker.match(/^const CORE = (\{[^\n]+\});/m);
  if (!marker) throw Error('Lite worker asset sizes missing');
  const sizes = JSON.parse(marker[1]);
  for (const item of files.filter(f => f.file.startsWith('lite/') && f.file.endsWith('.js'))) {
    if (Object.hasOwn(sizes, '/' + item.file)) sizes['/' + item.file] = (await fs.stat(path.join(stage, 'app', item.file))).size;
  }
  const version = hash(files.map(f => f.sha256).join('')).slice(0, 12);
  worker = worker.replace(/^const CACHE = '[^']+';/m, `const CACHE = 'codex-desktop-lite-subagent-history-${version}';`).replace(marker[0], 'const CORE = ' + JSON.stringify(sizes) + ';');
  await save('lite/sw.js', Buffer.from(worker));
  await fs.writeFile(path.join(stage, 'manifest.json'), JSON.stringify({files}, null, 2));
  return {stage, files: files.length, version};
}

export async function publishLocalSubagentHistory(stage, root) {
  const manifest = JSON.parse(await fs.readFile(path.join(stage, 'manifest.json'), 'utf8'));
  const acceptance = JSON.parse(await fs.readFile(path.join(stage, 'acceptance.json'), 'utf8'));
  if (acceptance.mutations !== 0 || acceptance.reports.length !== 2) throw Error('Subagent history acceptance missing');
  for (const item of manifest.files) {
    const target = path.resolve(root, item.file);
    if (!target.startsWith(path.resolve(root) + path.sep)) throw Error('Asset outside webview');
    if (hash(await fs.readFile(target)) !== item.before) throw Error('Live asset changed: ' + item.file);
    if (hash(await fs.readFile(path.join(stage, 'app', item.file))) !== item.sha256 || acceptance.assets[item.file] !== item.sha256) throw Error('Candidate changed: ' + item.file);
  }
  const applied = [];
  try {
    for (const item of [...manifest.files].sort((a,b) => Number(a.file.endsWith('sw.js')) - Number(b.file.endsWith('sw.js')))) {
      const target = path.join(root, item.file);
      await fs.copyFile(path.join(stage, 'app', item.file), target + '.subagents-new');
      await fs.rename(target + '.subagents-new', target);
      applied.push(item);
    }
    for (const item of manifest.files) if (hash(await fs.readFile(path.join(root, item.file))) !== item.sha256) throw Error('Published asset differs: ' + item.file);
  } catch (error) {
    for (const item of applied) await fs.copyFile(path.join(stage, 'before', item.file), path.join(root, item.file));
    throw error;
  }
  const report = {state: 'published', files: applied.length, backendRestarted: false};
  await fs.writeFile(path.join(stage, 'deployment.json'), JSON.stringify(report, null, 2));
  return report;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv[2] === '--stage') console.log(JSON.stringify(await stageSubagentHistory(process.argv[3], process.argv[4])));
  else if (process.argv[2] === '--publish-local') console.log(JSON.stringify(await publishLocalSubagentHistory(process.argv[3], process.argv[4])));
  else for (const [name, patch] of patches) {
    const target = 'scratch/asar/webview/assets/' + name;
    await fs.writeFile(target, patch(await fs.readFile(target, 'utf8')));
  }
}
