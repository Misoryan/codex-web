import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {brotliCompressSync, gzipSync, constants} from 'node:zlib';

const helper = `function codexWebAgentTitle(thread) {
  const value = thread?.name ?? thread?.agentDisplayName;
  return typeof value === "string" ? value.trim() || null : null;
}\n`;

function once(source, pattern, replace, label) {
  if ([...source.matchAll(pattern)].length !== 1) throw Error(`Agent title anchor changed: ${label}`);
  return source.replace(pattern, replace);
}

export function patchAgentTitleMetadata(source) {
  if (source.includes('function codexWebAgentTitle(')) return source;
  const copies = /agentNickname:\s*(\w+)\.agentNickname/g;
  if ([...source.matchAll(copies)].length !== 5) throw Error('Agent metadata copies changed');
  source = source.replace(copies, (_, value) => `agentDisplayName:${value}.name??${value}.agentDisplayName??null,agentNickname:${value}.agentNickname`);
  source = once(source,
    /agentNickname:\s*(\w+)\((\w+)\),\s*mode:\s*\2\.mode/g,
    (match, fn, value) => `agentDisplayName:codexWebAgentTitle(${value}),${match}`,
    'summary projection');
  source = once(source,
    /function\s+(\w+)\((\w+)\)\s*\{\s*return\s+\2\s*==\s*null\s*\?\s*null\s*:\s*\(?\s*(\w+)\(\2\.agentNickname\)\s*\?\?\s*\3\((\w+)\(\2\.source\)\?\.agentNickname\)\)?;?\s*\}/g,
    (_, fn, value, trim, sourceInfo) => `function ${fn}(${value}) {return ${value}==null?null:(${sourceInfo}(${value}.source)?.parentThreadId!=null?codexWebAgentTitle(${value}):null)??${trim}(${value}.agentNickname)??${trim}(${sourceInfo}(${value}.source)?.agentNickname)}`,
    'nickname projection');
  const rename = /([\w$]+)\.title = ([\w$]+);/g;
  const methods = ['async setThreadTitle(', 'applyThreadTitleUpdate('];
  for(const name of methods) {
    const at = source.indexOf(name);
    const end = source.indexOf('\n        }',at);
    if(at<0||end<at)throw Error('Native rename method changed: '+name);
    const part=source.slice(at,end);
    const patched=once(part,rename,(_,row,title)=>`${row}.title=${title}; if(${row}.source?.subAgent)${row}.agentDisplayName=${title};`,'native rename');
    source=source.slice(0,at)+patched+source.slice(end);
  }
  return helper + source;
}

export function patchAgentTitleRows(source) {
  if (source.includes('function codexWebAgentTitle(')) return source;
  const inputs = [...source.matchAll(/let\s+(\w+)\s*=\s*\w+\.get\((\w+)\.conversationId\),\s*(\w+)\s*=\s*\w+\.get\(\2\.conversationId\),\s*(\w+)\s*=\s*[$\w]+\(\1\?\.source\);/g)];
  if (inputs.length !== 1) throw Error('Agent membership inputs changed');
  const [, summary, row, cached] = inputs[0];
  source = once(source,
    /displayName:\s*(\w+)\.displayName\s*\?\?\s*\((\w+)\?\.agentPath/g,
    (match, value) => {
      if (value !== row) throw Error('Agent membership row changed');
      return match.replace(/displayName:\s*/, `displayName:codexWebAgentTitle(${summary})??codexWebAgentTitle(${cached})??`);
    }, 'membership name');
  source = once(source,
    /function\s+(\w+)\(\{\s*membership:\s*(\w+),\s*latestReference:\s*(\w+),\s*childConversation:\s*(\w+)\s*\}\)\s*\{\s*for\s*\(let\s+(\w+)\s+of\s*\[/g,
    (match, fn, membership, reference) => match + `codexWebAgentTitle(${reference}.thread),codexWebAgentTitle(${membership}.thread),`,
    'row name');
  return helper + source;
}

export function patchAgentTitleHeader(source) {
  if (/agentNickname:\(\w+\?\.name\?\.trim\(\)\|\|\w+\.agentNickname\|\|\w+\?\.agentNickname\)/.test(source)) return source;
  return once(source,
    /agentNickname:\s*(\w+)\?\.agentNickname\s*\?\?\s*(\w+)\.agentNickname/g,
    (_, raw, summary) => `agentNickname:(${raw}?.name?.trim()||${summary}.agentNickname||${raw}?.agentNickname)`,
    'child header');
}

export function patchAgentActivityTitles(source) {
  const marker = 'const codexWebAgentActivityTitleVersion = "saved-title-v1";';
  if (source.includes(marker)) return source;
  source = once(source,
    /c\s*=\s*o\s*&&\s*a\?\.showInlineActivity\s*===\s*!1\s*\?\s*a\.displayName\s*:\s*i\.displayName\s*!=\s*null\s*&&\s*i\.displayName\.trim\(\)\.length\s*>\s*0\s*\?\s*i\.displayName\s*:\s*a\?\.displayName/g,
    'c=o&&a?.showInlineActivity===!1?a.displayName:a?.displayName?.trim()&&a.displayName.trim()!==i.agentThreadId?a.displayName:i.displayName!=null&&i.displayName.trim().length>0?i.displayName:a?.displayName',
    'inline activity name');
  return marker + '\n' + source;
}

export const patches = [
  ['app-shared-8bd9d0399038.js', patchAgentTitleMetadata],
  ['app-primary-6f60e9ac4103.js', patchAgentTitleRows],
  ['local-conversation-page-a83a1af2c24b.js', patchAgentTitleHeader],
  ['sites-end-resource-78b98c374310.js', patchAgentActivityTitles],
];

export async function stageAgentTitles(baseline, stage) {
  const files = [];
  const hash = data => createHash('sha256').update(data).digest('hex');
  async function save(file, data) {
    const before = await fs.readFile(path.join(baseline, file));
    for (const [folder, content] of [['before', before], ['app', data]]) {
      const target = path.join(stage, folder, file);
      await fs.mkdir(path.dirname(target), {recursive: true});
      await fs.writeFile(target, content);
    }
    files.push({file, before: hash(before), sha256: hash(data)});
  }
  for (const prefix of ['', 'lite/']) {
    for (const [name, patch] of patches) {
      const file = prefix + 'assets/' + name;
      const data = Buffer.from(patch(await fs.readFile(path.join(baseline, file), 'utf8')));
      await save(file, data);
      for (const [ext, compress] of [
        ['.br', b => brotliCompressSync(b, {params: {[constants.BROTLI_PARAM_QUALITY]: 4}})],
        ['.gz', gzipSync],
      ]) {
        try {await fs.access(path.join(baseline, file + ext));} catch {continue;}
        await save(file + ext, compress(data));
      }
    }
  }
  let worker = await fs.readFile(path.join(baseline, 'lite/sw.js'), 'utf8');
  const marker = worker.match(/^const CORE = (\{[^\n]+\});/m);
  if (!marker) throw Error('Lite worker asset sizes missing');
  const sizes = JSON.parse(marker[1]);
  for (const item of files.filter(f => f.file.startsWith('lite/') && f.file.endsWith('.js'))) {
    if (Object.hasOwn(sizes, '/' + item.file)) sizes['/' + item.file] = (await fs.stat(path.join(stage, 'app', item.file))).size;
  }
  const version = hash(Buffer.from(files.map(f => f.sha256).join(''))).slice(0, 12);
  worker = worker.replace(/^const CACHE = '[^']+';/m, `const CACHE = 'codex-desktop-lite-agents-${version}';`).replace(marker[0], 'const CORE = ' + JSON.stringify(sizes) + ';');
  await save('lite/sw.js', Buffer.from(worker));
  await fs.writeFile(path.join(stage, 'manifest.json'), JSON.stringify({files}, null, 2));
  return {stage, files: files.length, version};
}

export async function publishLocalAgentTitles(stage, root) {
  const hash = data => createHash('sha256').update(data).digest('hex');
  const manifest = JSON.parse(await fs.readFile(path.join(stage, 'manifest.json'), 'utf8'));
  const acceptance = JSON.parse(await fs.readFile(path.join(stage, 'acceptance.json'), 'utf8'));
  if (acceptance.mutations !== 0 || acceptance.reports.length !== 2 || acceptance.reports.some(report => report.nativeInlineActivity !== true)) throw Error('Agent title acceptance missing');
  for (const item of manifest.files) {
    const target = path.resolve(root, item.file);
    if (!target.startsWith(path.resolve(root) + path.sep)) throw Error('Asset outside webview');
    if (hash(await fs.readFile(target)) !== item.before) throw Error('Live asset changed: ' + item.file);
    if (hash(await fs.readFile(path.join(stage, 'app', item.file))) !== item.sha256 || acceptance.assets[item.file] !== item.sha256) throw Error('Candidate changed: ' + item.file);
  }
  const applied = [];
  try {
    for (const item of manifest.files) {
      const target = path.join(root, item.file);
      await fs.copyFile(path.join(stage, 'app', item.file), target + '.agents-new');
      await fs.rename(target + '.agents-new', target);
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
  if (process.argv[2] === '--stage') {
    console.log(JSON.stringify(await stageAgentTitles(process.argv[3], process.argv[4])));
  } else if (process.argv[2] === '--publish-local') {
    console.log(JSON.stringify(await publishLocalAgentTitles(process.argv[3], process.argv[4])));
  } else {
    for (const [name, patch] of patches) {
      const file = 'scratch/asar/webview/assets/' + name;
      await fs.writeFile(file, patch(await fs.readFile(file, 'utf8')));
    }
  }
}
