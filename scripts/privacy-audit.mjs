import fs from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
process.chdir(root);
function git(args, binary = false) {
  const result = spawnSync('git', args, {cwd: root, encoding: binary ? undefined : 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024});
  if (result.error) throw result.error;
  if (result.status !== 0) throw Error(`git ${args[0]} failed`);
  return result.stdout;
}
const staged = process.argv.includes('--staged');
const files = [...new Set(git(staged
  ? ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']
  : ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean))];
const rules = [
  ['private artifact', /(?:^|\/)(?:auth|runtime|storage-cache|scratch[^/]*|node_modules|logs|outputs|\.ssh)(?:\/|$)|(?:^|\/)(?:statsig-state|browser-sidebar-page-states|sub2api-profile|auth)\.json|\.(?:db|sqlite3?|pem|key|pfx|p12|log|jsonl|bak|pyc)$/i],
  ['environment file', /(?:^|\/)\.env(?:\..+)?$/],
];
const patterns = [
  ['absolute user path', /\b[A-Za-z]:[\\/]|\/(?:Users|home)\/[A-Za-z0-9._-]+\//i],
  ['private network address', /\b(?:10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)\b/],
  ['recorded conversation ID', /\b01[0-9a-f]{6}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i],
  ['embedded bitmap', /data:image\/(?:png|jpe?g|webp);base64,[A-Za-z0-9+/=]{256,}/i],
];
const allowedHosts = /^(?:localhost|127\.0\.0\.1|(?:.*\.)?example\.(?:com|invalid|org)|attacker\.invalid|fixture|local|github\.com|api\.github\.com|raw\.githubusercontent\.com|persistent\.oaistatic\.com|registry\.npmjs\.org|www\.electronjs\.org|electronjs\.org|aka\.ms|nix-community\.github\.io|paulmillr\.com)$/i;
const provenance = JSON.parse(await fs.readFile('provenance.json', 'utf8'));
const baseline = git(['grep', '-I', '-h', '-e', '://', '-e', '@', provenance.upstreamCommit, '--']);
const upstreamHosts = new Set([...baseline.matchAll(/(?:https?|wss?):\/\/([A-Za-z0-9.-]+)(?::\d+)?/g)].map(match => match[1].toLowerCase()));
const upstreamEmails = new Set([...baseline.matchAll(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g)].map(match => match[0]));
const findings = [];
function inspect(file, data, revision = 'working tree') {
  for (const [rule, pattern] of rules) if (pattern.test(file) && !(file === '.env.example' && rule === 'environment file')) findings.push({file, rule, revision});
  if (data.includes(0)) { findings.push({file, rule: 'binary requires manual review', revision}); return; }
  const lines = data.toString('utf8').split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const [rule, pattern] of patterns) if (pattern.test(line)) findings.push({file, line: index + 1, rule, revision});
    for (const match of line.matchAll(/[\w.+-]+@([\w.-]+\.[A-Za-z]{2,})/g)) {
      if (!/^(?:users\.noreply\.github\.com|example\.(?:com|invalid|org))$/i.test(match[1]) && !upstreamEmails.has(match[0])) {
        findings.push({file, line: index + 1, rule: 'email address', revision});
      }
    }
    for (const match of line.matchAll(/(?:https?|wss?):\/\/([A-Za-z0-9.-]+)(?::\d+)?/g)) if (!allowedHosts.test(match[1]) && !upstreamHosts.has(match[1].toLowerCase())) findings.push({file, line: index + 1, rule: 'unreviewed external host', revision});
  });
}
const contents = new Map();
for (const file of files) {
  let data;
  if (staged) data = git(['show', ':' + file], true);
  else {
    try { data = await fs.readFile(file); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
  }
  contents.set(file, data);
  inspect(file, data);
}
if (process.argv.includes('--history')) {
  for (const commit of git(['rev-list', `HEAD`, '--not', provenance.upstreamCommit]).trim().split('\n').filter(Boolean)) {
    const changed = git(['diff-tree', '--root', '--no-commit-id', '--name-only', '--diff-filter=ACMR', '-r', '-z', commit]).split('\0').filter(Boolean);
    for (const file of changed) inspect(file, git(['show', `${commit}:${file}`], true), commit.slice(0, 12));
  }
}
if (findings.length) {
  console.error(JSON.stringify({passed: false, findings}, null, 2));
  process.exit(1);
}

await fs.mkdir('runtime/tmp', {recursive: true});
const snapshot = await fs.mkdtemp(path.resolve('runtime/tmp/privacy-'));
const gitleaks = process.env.GITLEAKS_PATH || 'gitleaks';
function secrets(args) {
  const result = spawnSync(gitleaks, [...args, '--redact', '--no-banner', '--log-level=error'], {encoding: 'utf8', windowsHide: true});
  if (result.error) throw Error('Install Gitleaks or set GITLEAKS_PATH before publishing');
  if (result.status !== 0) throw Error('Gitleaks rejected the publication candidate; inspect it locally with redaction enabled');
}
try {
  for (const [file, data] of contents) {
    const destination = path.join(snapshot, file);
    await fs.mkdir(path.dirname(destination), {recursive: true});
    await fs.writeFile(destination, data);
  }
  secrets(['dir', snapshot]);
  if (process.argv.includes('--history')) secrets(['git', root, '--log-opts=--all']);
} finally { await fs.rm(snapshot, {recursive: true}); }
console.log(JSON.stringify({passed: true, files: contents.size, staged, history: process.argv.includes('--history'), secrets: 'Gitleaks'}));
