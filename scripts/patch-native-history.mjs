import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {patchConversationOpening} from './chat-loading-patch.mjs';
import {patchLatestHistoryTail} from './history-tail-patch.mjs';
import {patchUnarchive} from './unarchive-patch.mjs';

export function patchNativeHistory(source) {
  return patchUnarchive(patchConversationOpening(patchLatestHistoryTail(source)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const directory = path.resolve('scratch/asar/.vite/build');
  const matches = [];
  for (const name of await fs.readdir(directory)) {
    if (!name.startsWith('src-') || !name.endsWith('.js')) continue;
    const source = await fs.readFile(path.join(directory, name), 'utf8');
    if (source.includes('thread/items/list repeated cursor')) matches.push({name, source});
  }
  if (matches.length !== 1) throw Error('Native history module changed');
  const {name, source} = matches[0];
  await fs.writeFile(path.join(directory, name), patchNativeHistory(source));
  console.log('Patched native history loading');
}
