const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const path = require('node:path');
const modulePath = path.resolve(process.argv[2] || 'src/server/electron/index.js');
const code = `
const assert = require('node:assert/strict');
let delivered;
global.__codexElectronIpcBridge = {sendToRenderer(id, message) { delivered = message; }};
const {BrowserWindow} = require(${JSON.stringify(modulePath)});
const window = new BrowserWindow({});
const payload = {type: 'test-notification', text: 'bridge-payload-marker'};
window.webContents.send('test-channel', payload);
assert.equal(delivered.channel, 'test-channel');
assert.strictEqual(delivered.args[0], payload);
`;
for (const enabled of [false, true]) {
 const result = spawnSync(process.execPath, ['-e', code], {
  encoding: 'utf8', env: {...process.env, NODE_DEBUG: enabled ? 'codex-web-electron' : ''}
 });
 assert.equal(result.status, 0, result.stderr);
 assert.equal(result.stdout, '');
 assert.equal(result.stderr.includes('bridge-payload-marker'), enabled);
}
console.log('PASS: normal bridge traffic is silent; explicit debug works; payload delivery preserves identity.');
