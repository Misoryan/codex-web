import fs from 'node:fs/promises';
import {spawnSync} from 'node:child_process';

await fs.mkdir('runtime/tmp', {recursive: true});
const tests = process.argv.includes('--desktop') ? [
  'test-activity-history.cjs', 'test-async-question-sync.cjs', 'test-chat-loading.cjs',
  'test-history-tail.cjs', 'test-pwa-resource-loading.cjs', 'test-pwa-style-update.cjs',
] : [
  'test-machine-api.mjs',
  'test-statsig-cache.cjs', 'test-resumable-sessions.cjs', 'test-sub2api-capacity.cjs',
  'test-usage-cost-api.cjs', 'test-electron-logging.cjs', 'test-public-connection.cjs',
  'test-browser-guest.cjs', 'test-monitoring.cjs', 'test-workflow-runtime.cjs', 'test-workflow-lifecycle.cjs', 'test-workflow-publication.cjs', 'test-workflow-activity.cjs',
  'test-mcp-app-sandbox.cjs', 'test-profile-identity.cjs', 'test-workflow-inbox.cjs',
];
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('CODEX_WORKFLOW_') || key.startsWith('CODEX_WORKFLOW_TEST_')));
for (const test of tests) {
  console.log(`\n${test}`);
  const result = spawnSync(process.execPath, ['scripts/' + test], {
    stdio: 'inherit', windowsHide: true, env: {...environment, CODEX_WORKFLOW_OBSERVER_IPC_URLS: ''},
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
