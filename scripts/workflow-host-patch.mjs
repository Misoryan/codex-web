import fs from 'node:fs/promises';
import path from 'node:path';

export async function patchWorkflowHost(root = 'scratch/asar') {
  const file = path.join(root, '.vite/build/main-CqEoQDOU.js');
  let source = await fs.readFile(file, 'utf8');
  if (source.includes('__codexWorkflowHost')) return;
  const anchor = 'setWindowContext: (e) => {\n      R = e;';
  if (source.split(anchor).length !== 2) throw Error('Native window context changed');
  source = source.replace(anchor, anchor + '\n      if (process.env.CODEX_WORKFLOW_CWD) globalThis.__codexWorkflowHost = e;');
  await fs.writeFile(file, source);
}
