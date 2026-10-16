import fs from 'node:fs/promises';
import {createReadStream, createWriteStream} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {pipeline} from 'node:stream/promises';
import {promisify} from 'node:util';
import yauzl from 'yauzl';
import {extractAll} from '@electron/asar';
import sharp from 'sharp';

const root = path.resolve(import.meta.dirname, '..');
process.chdir(root);
const desktop = JSON.parse(await fs.readFile('desktop.json', 'utf8'));
const expected = Buffer.from(desktop.sha256, 'base64').toString('hex');
const scratch = path.join(root, 'scratch');
await fs.mkdir('runtime/cache', {recursive: true});
await fs.mkdir('runtime/tmp', {recursive: true});
const archive = path.resolve(process.env.HOSTED_CODEX_APP_ZIP || `runtime/cache/ChatGPT-${desktop.version}.zip`);
if (archive.startsWith(scratch + path.sep)) throw Error('Keep the source archive outside scratch/');

async function checksum(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
if (!(await fs.stat(archive).catch(error => {
  if (error.code !== 'ENOENT') throw error;
}))) {
  if (process.env.HOSTED_CODEX_APP_ZIP) throw Error('HOSTED_CODEX_APP_ZIP does not exist');
  const url = `https://persistent.oaistatic.com/codex-app-prod/ChatGPT-darwin-arm64-${desktop.version}.zip`;
  console.log(`Downloading Codex Desktop ${desktop.version}`);
  const partial = archive + '.partial';
  run('curl', ['--fail', '--location', '--silent', '--show-error', '--retry', '3', '--connect-timeout', '30', '--speed-limit', '1024', '--speed-time', '60', '--output', partial, url]);
  if (await checksum(partial) !== expected) throw Error('Desktop archive checksum mismatch');
  await fs.rename(partial, archive);
}
if (await checksum(archive) !== expected) throw Error('Desktop archive checksum mismatch');

if (await fs.stat(scratch).catch(error => {
  if (error.code !== 'ENOENT') throw error;
})) await fs.rm(scratch, {recursive: true});
await fs.mkdir(scratch);
const resources = 'ChatGPT.app/Contents/Resources/';
const zip = await promisify(yauzl.open)(archive, {lazyEntries: true});
await new Promise((resolve, reject) => {
  zip.on('error', reject);
  zip.on('end', resolve);
  zip.on('entry', async entry => {
    try {
      const selected = entry.fileName === resources + 'app.asar'
        || entry.fileName.startsWith(resources + 'app.asar.unpacked/')
        || entry.fileName.startsWith(resources + 'plugins/')
        || (entry.fileName.startsWith(resources + 'cua_node/') && !entry.fileName.includes('/.bin/'));
      if (selected) {
        const destination = path.resolve(scratch, entry.fileName);
        if (!destination.startsWith(scratch + path.sep)) throw Error('Archive entry escapes scratch/');
        if ((entry.externalFileAttributes >>> 16 & 0xf000) === 0xa000) throw Error('Unexpected resource symlink');
        if (entry.fileName.endsWith('/')) await fs.mkdir(destination, {recursive: true});
        else {
          await fs.mkdir(path.dirname(destination), {recursive: true});
          const input = await promisify(zip.openReadStream.bind(zip))(entry);
          await pipeline(input, createWriteStream(destination));
        }
      }
      zip.readEntry();
    } catch (error) { zip.close(); reject(error); }
  });
  zip.readEntry();
});
extractAll(path.join(scratch, resources, 'app.asar'), path.join(scratch, 'asar'));
for (const file of await fs.readdir('assets')) await fs.copyFile(path.join('assets', file), path.join(scratch, 'asar/webview', file));
await sharp(path.join(scratch, 'asar/webview/assets/app-f483cb0295ed.png'))
  .resize(384, 384, {fit: 'inside'}).flatten({background: 'white'})
  .extend({top: 64, bottom: 64, left: 64, right: 64, background: 'white'})
  .removeAlpha().png().toFile(path.join(scratch, 'asar/webview/assets/pwa-icon-512.png'));

function run(command, args) {
  const result = spawnSync(command, args, {cwd: root, stdio: 'inherit', windowsHide: true});
  if (result.error) throw result.error;
  if (result.status !== 0) throw Error(`${command} exited with status ${result.status}`);
}
const patches = [
  'webview-remove-csp', 'webview-style', 'webview-preload', 'webview-favicon', 'webview-pwa',
  'webview-thread-title', 'webview-initial-route', 'webview-electron-shim-close-sidebar',
  'webview-prosemirror-inputmode', 'webview-use-atfs-for-local-files',
  'webview-statsig-override-adapter', 'webview-prompt-search-param', 'sentry-disable-shell',
  'sentry-disable-webview', 'preload-disable-device-check', 'webview-safe-header-left',
  'app-host-json-rpc', 'app-host-browser-windows', 'app-host-global-state-sync', 'web-thread-release',
];
const formatted = new Set();
for (const name of patches) {
  const patch = await fs.readFile(`patches/${name}.patch`, 'utf8');
  for (const [, file] of patch.matchAll(/^\+\+\+ b\/(.+)$/gm)) formatted.add(path.join('scratch/asar', file.trim()));
}
const webviewPatch = await fs.readFile('scripts/patch-webview.mjs', 'utf8');
for (const [, file] of webviewPatch.matchAll(/\['([^']+\.js)',\[/g)) formatted.add('scratch/asar/webview/assets/' + file);
for (const file of await fs.readdir('scratch/asar/webview/assets')) {
  if (/^zh-(CN|HK|TW)-.*\.js$/.test(file)) formatted.add('scratch/asar/webview/assets/' + file);
}
await fs.writeFile('runtime/tmp/prettier-ignore', '');
run(process.execPath, ['node_modules/prettier/bin/prettier.cjs', '--ignore-path', 'runtime/tmp/prettier-ignore', '--write', ...formatted]);
for (const name of patches) run('git', ['apply', '--no-index', '--unsafe-paths', '--directory=scratch/asar', `patches/${name}.patch`]);
await fs.rm('scratch/asar/node_modules/better-sqlite3', {recursive: true});
for (const file of ['scripts/app-tools-patch.cjs', 'scripts/bundle-browser-runtime.cjs', 'scripts/patch-webview.mjs']) run(process.execPath, [file]);
console.log(`Prepared Codex Desktop ${desktop.version}`);
