import fs from 'node:fs/promises';

export function patchBrowserUploads(source) {
  if(source.includes('CODEX_BROWSER_UPLOAD_LABEL'))return source;
  const classification = /(\w+)\.fsPath\s*\|\|\s*\1\.path\s*\|\|\s*\1\.label/g;
  if ([...source.matchAll(classification)].length !== 1) throw Error('Composer attachment format changed');
  return source.replace(classification, '$1.label /* CODEX_BROWSER_UPLOAD_LABEL */');
}

if (process.argv[1]?.endsWith('browser-upload-patch.mjs')) {
  const file = 'scratch/asar/webview/assets/app-initial-6350d04672d0.js';
  await fs.writeFile(file, patchBrowserUploads(await fs.readFile(file, 'utf8')));
}
