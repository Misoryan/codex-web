import fs from 'node:fs/promises';
import {spawnSync} from 'node:child_process';

await fs.mkdir('runtime/tmp', {recursive: true});
const tests = process.argv.includes('--desktop') ? [
  'test-log-storage.cjs',
  'test-service-tier.cjs',
  'test-native-rpc-subscriptions.cjs',
  'test-code-review-performance.cjs',
  'test-code-review-ui.cjs',
  'test-code-review-merge-readiness.cjs',
  'test-code-review-sequential-merges.cjs',
  'test-code-review-resources.cjs',
  'test-unarchive.cjs',
  'test-client-capabilities.cjs',
  'test-automation-scheduler.mjs',
  'test-sidebar-runtime.mjs', 'test-startup-preloads.mjs', 'test-startup-scheduling.mjs', 'test-evaluation-bootstrap.mjs', 'test-browser-lifecycle.cjs',
  'test-native-history.cjs', 'test-console-capacity.cjs',
  'test-activity-history.cjs', 'test-async-question-sync.cjs', 'test-chat-loading.cjs',
  'test-history-tail.cjs', 'test-pwa-resource-loading.cjs', 'test-pwa-style-update.cjs',
] : [
  'test-native-thread-retention.mjs',
  'test-global-state-sync.cjs', 'test-statsig-cache.cjs', 'test-feature-config.cjs', 'test-resumable-sessions.cjs', 'test-sub2api-capacity.cjs',
  'test-usage-cost-api.cjs', 'test-sub2api-loading.cjs', 'test-electron-logging.cjs', 'test-public-connection.cjs',
  'test-browser-guest.cjs', 'test-monitoring.cjs', 'test-mcp-app-sandbox.cjs',
  'test-profile-identity.cjs', 'test-local-profile.cjs',
];
for (const test of tests) {
  console.log(`\n${test}`);
  const result = spawnSync(process.execPath, ['scripts/' + test], {
    stdio: 'inherit', windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
