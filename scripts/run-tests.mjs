import fs from 'node:fs/promises';
import {spawnSync} from 'node:child_process';

await fs.mkdir('runtime/tmp', {recursive: true});
const tests = process.argv.includes('--desktop') ? [
  'test-activity-history.cjs', 'test-async-question-sync.cjs', 'test-chat-loading.cjs',
  'test-history-tail.cjs', 'test-pwa-resource-loading.cjs', 'test-pwa-style-update.cjs',
] : [
  'test-statsig-cache.cjs', 'test-resumable-sessions.cjs', 'test-sub2api-capacity.cjs',
  'test-usage-cost-api.cjs', 'test-electron-logging.cjs', 'test-public-connection.cjs',
  'test-browser-guest.cjs', 'test-monitoring.cjs',
];
for (const test of tests) {
  console.log(`\n${test}`);
  const result = spawnSync(process.execPath, ['scripts/' + test], {stdio: 'inherit', windowsHide: true});
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
