const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {buildSync} = require('esbuild');

fs.mkdirSync('runtime/tmp', {recursive: true});
const temporaryRoot = path.resolve('runtime/tmp');
const root = fs.mkdtempSync(path.join(temporaryRoot, 'log-storage-'));
for (const name of ['log-storage', 'process-logging']) buildSync({
  entryPoints: [`src/server/${name}.ts`], outfile: path.join(root, `${name}.cjs`),
  bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
});
const {MonitoringDestination} = require(path.join(root, 'log-storage.cjs'));
const {installProcessLogging} = require(path.join(root, 'process-logging.cjs'));

async function main() {
  // Utility contract: disk-full and unwritable-directory failures are reported
  // as dropped records and close settles. Only the external filesystem fails.
  const open = fsp.open;
  let attempts = 0;
  fsp.open = async () => { attempts++; throw Object.assign(new Error('fixture full disk'), {code: 'ENOSPC'}); };
  const failed = new MonitoringDestination(path.join(root, 'full'));
  failed.write('first\n');
  await failed.flush();
  failed.write('second\n');
  fsp.open = open;
  assert.equal(failed.droppedRecords, 2);
  assert.equal(attempts, 1, 'A full disk must not cause a retry storm');
  const now = Date.now;
  Date.now = () => now() + 61_000;
  failed.write('recovered\n');
  await failed.close();
  Date.now = now;
  const recovered = fs.readdirSync(path.join(root, 'full')).map(name => fs.readFileSync(path.join(root, 'full', name), 'utf8')).join('');
  assert.equal(recovered, 'recovered\n', 'Logging must resume after disk capacity is restored');

  fsp.open = async (...args) => {
    const file = await open(...args);
    file.writeFile = async () => { throw Object.assign(new Error('fixture disk filled during write'), {code: 'ENOSPC'}); };
    return file;
  };
  const filledDuringWrite = new MonitoringDestination(path.join(root, 'write-full'));
  filledDuringWrite.write('first\n');
  filledDuringWrite.write('second\n');
  await filledDuringWrite.close();
  fsp.open = open;
  assert.equal(filledDuringWrite.droppedRecords, 2, 'A failed write must settle and account for queued records');

  const blockedPath = path.join(root, 'directory-is-file');
  fs.writeFileSync(blockedPath, 'preserved');
  const blocked = new MonitoringDestination(blockedPath);
  blocked.write('record\n');
  await blocked.close();
  assert.equal(blocked.droppedRecords, 1);
  assert.equal(fs.readFileSync(blockedPath, 'utf8'), 'preserved');

  // Utility contract: a burst has at most 1 MiB pending, and retained data has
  // at most seven files of 10 MiB each. Expectations are the documented bounds.
  const directory = path.join(root, 'bounded');
  const destination = new MonitoringDestination(directory);
  const chunk = Buffer.alloc(1024 * 1024, 'x');
  destination.write(chunk);
  destination.write(chunk);
  await destination.flush();
  assert.equal(destination.droppedRecords, 1, 'Queued bytes must include the in-flight write');
  for (let index = 1; index < 81; index++) {
    destination.write(chunk);
    await destination.flush();
  }
  await destination.close();
  const retained = fs.readdirSync(directory).map(name => fs.statSync(path.join(directory, name)));
  assert.equal(retained.length, 7);
  assert(retained.every(file => file.size <= 10 * 1024 * 1024));
  assert.equal(retained.reduce((sum, file) => sum + file.size, 0), 61 * 1024 * 1024);

  const consoleDirectory = path.join(root, 'console');
  const logging = installProcessLogging(consoleDirectory);
  console.warn('fixture console record');
  const bootstrap = fs.readFileSync('scratch/asar/.vite/build/bootstrap-CooIJpZm.js', 'utf8');
  const nativeStart = bootstrap.indexOf('function rT(');
  const nativeEnd = bootstrap.indexOf('function oT(', nativeStart);
  assert(nativeStart >= 0 && nativeEnd > nativeStart, 'Pinned Desktop console boundary must exist');
  const nativeConsole = new Function(bootstrap.slice(nativeStart, nativeEnd) + '; return aT();')();
  const writeSync = fs.writeSync;
  let rawWrites = 0;
  fs.writeSync = (descriptor, ...args) => {
    if (descriptor === 1 || descriptor === 2) {
      rawWrites++;
      throw Object.assign(new Error('fixture raw console disk failure'), {code: 'ENOSPC'});
    }
    return writeSync(descriptor, ...args);
  };
  nativeConsole('info', 'fixture native console record');
  fs.writeSync = writeSync;
  process.stderr.emit('error', Object.assign(new Error('fixture broken pipe'), {code: 'EPIPE'}));
  await logging.close();
  assert.equal(logging.droppedRecords, 1);
  const consoleText = fs.readdirSync(consoleDirectory).map(name => fs.readFileSync(path.join(consoleDirectory, name), 'utf8')).join('');
  assert(consoleText.includes('fixture console record'));
  assert(consoleText.includes('fixture native console record'), 'The real Desktop aT logger must reach bounded storage');
  assert.equal(rawWrites, 0, 'The native logger must not bypass bounded storage through a raw stdout descriptor');
  const uncaught = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(path.join(root, 'process-logging.cjs'))}).installProcessLogging(${JSON.stringify(consoleDirectory)}); throw new Error('fixture business failure');`], {encoding: 'utf8', windowsHide: true});
  assert.notEqual(uncaught.status, 0, 'Installing logging must not suppress application failures');
  assert(uncaught.stderr.includes('fixture business failure'));

  if (process.platform === 'win32') {
    const test = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      path.resolve('scripts/test-log-retention.ps1'), '-Root', path.join(root, 'supervisor')], {encoding: 'utf8', windowsHide: true});
    assert.equal(test.status, 0, test.stdout + test.stderr);
  }
  console.log(JSON.stringify({passed: true, fullDiskSurvived: true, retainedFiles: 7, queueBytes: 1048576, consolePipeErrorSurvived: true, nativeConsoleCaptured: true}));
}
main().finally(() => {
  assert(root.startsWith(temporaryRoot + path.sep) && !fs.lstatSync(root).isSymbolicLink(), 'Cleanup must stay inside the task temporary directory');
  if (process.platform === 'win32') {
    const quoted = root.replace(/'/g, "''");
    const cleanup = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Remove-Item -LiteralPath '${quoted}' -Recurse -ErrorAction Stop`], {encoding: 'utf8', windowsHide: true});
    if (cleanup.status !== 0) throw new Error(cleanup.stderr || 'Test directory cleanup failed');
  } else fs.rmSync(root, {recursive: true});
}).catch(error => {console.error(error); process.exitCode = 1;});
