const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

const bundle = path.resolve(process.argv[2] || 'scratch/asar/.vite/build/bootstrap-CooIJpZm.js');
const source = fs.readFileSync(bundle, 'utf8');
const start = source.indexOf('function rT(');
const end = source.indexOf('function oT(', start);
assert(start >= 0 && end > start, 'Pinned Desktop console implementation must exist');
const implementation = source.slice(start, end);

for (const errorCode of ['ENOSPC', 'EDQUOT', 'EPIPE', 'EIO']) {
  const program = `
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const http = require('node:http');
    ${implementation}
    const originalWrite = fs.writeSync;
    let injected = 0;
    fs.writeSync = function (descriptor, ...args) {
      if (descriptor === 1) {
        injected++;
        throw Object.assign(new Error('injected console capacity failure'), {code: ${JSON.stringify(errorCode)}});
      }
      return originalWrite.call(this, descriptor, ...args);
    };
    iT();
    aT()('info', 'console write fault probe');
    setImmediate(async () => {
      assert.equal(injected, 1, 'The real console must reach the failing filesystem write');
      const server = http.createServer((_request, response) => response.end('alive-after-console-failure'));
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      try {
        const response = await fetch('http://127.0.0.1:' + server.address().port);
        assert.equal(response.status, 200);
        assert.equal(await response.text(), 'alive-after-console-failure');
      } finally {
        await new Promise(resolve => server.close(resolve));
      }
      fs.writeSync(2, 'CONSOLE_FAILURE_SURVIVED');
    });
  `;
  const outputFile = path.resolve('runtime/tmp/console-capacity-' + errorCode + '-' + process.pid + '.log');
  const output = fs.openSync(outputFile, 'w');
  let result;
  try {
    result = spawnSync(process.execPath, ['-e', program], {
      stdio: ['ignore', output, 'pipe'], encoding: 'utf8', timeout: 15000, windowsHide: true,
    });
  } finally {
    fs.closeSync(output);
    fs.unlinkSync(outputFile);
  }
  assert.ifError(result.error);
  if (errorCode === 'EIO') {
    assert.notEqual(result.status, 0, 'Unexpected filesystem failures must not be swallowed');
    assert.match(result.stderr, /injected console capacity failure/);
    assert(!result.stderr.includes('CONSOLE_FAILURE_SURVIVED'));
  } else {
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /CONSOLE_FAILURE_SURVIVED/);
  }
}
console.log('PASS: native console capacity errors preserve process HTTP responsiveness; unexpected errors still fail.');
