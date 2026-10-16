import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

export function patchReasoningLabels(source) {
  if(!source.includes('composer.mode.local.reasoning.none.label'))return source;
  const labels = {none:'None', minimal:'Minimal', low:'Light', medium:'Medium', high:'High', xhigh:'Extra High', max:'Max', ultra:'Ultra', persistent:'Persistent'};
  for (const [effort, label] of Object.entries(labels)) {
    const key = `composer.mode.local.reasoning.${effort}.label${effort === 'low' ? '.v2' : ''}`;
    const pattern = new RegExp(`("${key.replaceAll('.', '\\.')}"\\s*:\\s*)\x60[^\x60]*\x60`, 'g');
    if ([...source.matchAll(pattern)].length !== 1) throw Error(`Reasoning label changed: ${key}`);
    source = source.replace(pattern, (_, prefix) => prefix + '`' + label + '`');
  }
  return source;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const root = 'scratch/asar/webview/assets';
  for (const name of fs.readdirSync(root).filter(n => /^zh-(CN|HK|TW)-.*\.js$/.test(n))) {
    const file = path.join(root, name);
    fs.writeFileSync(file, patchReasoningLabels(fs.readFileSync(file, 'utf8')));
  }
}
