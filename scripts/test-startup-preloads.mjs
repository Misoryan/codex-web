import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {withStartupPreloads,withVersionedAssets} from '../ops/startup-preloads.mjs';

const root=path.resolve('runtime/startup-preload-test');
await fs.mkdir(path.join(root,'assets'),{recursive:true});
for(const [name,source] of Object.entries({
  'app-initial-test.js':'import "./shared.js"; export const ready=true;',
  'local-conversation-page-test.js':'export {ready} from "./app-initial-test.js"; import("./optional.js");',
  'shared.js':'import "./app-initial-test.js";',
}))await fs.writeFile(path.join(root,'assets',name),source);
const html='<html><head><base href="/lite/" /><script data-startup-assets>window.__codexStartupAssets={"/lite/assets/shared.js":42};</script><link rel="modulepreload" href="./assets/shared.js"><script src="/lite/assets/preload.js"></script><link href="https://example.org/help"></head></html>';
const output=await withStartupPreloads(html,root,'/lite/');
assert.equal((output.match(/href="[^\"]*shared.js"/g)||[]).length,1,'Existing preloads are not duplicated');
assert(output.includes('href="/lite/assets/app-initial-test.js"'));
assert(!output.includes('href="/lite/assets/local-conversation-page-test.js"'),'Conversation dependencies must not compete with shell startup');
assert(!output.includes('optional.js'),'Dynamic imports remain on demand');
assert.equal(await withStartupPreloads(output,root,'/lite/'),output,'Rebuilding does not accumulate links');
const versioned=withVersionedAssets(output,'release-test');
assert(versioned.includes('src="/codex-static/release-test/lite/assets/preload.js"'));
assert(versioned.includes('"/codex-static/release-test/lite/assets/shared.js":42'));
assert(versioned.includes('href="https://example.org/help"'));
assert(versioned.includes('<base href="/lite/" />'),'Application routes do not change');
assert.equal(withVersionedAssets(versioned,'release-test'),versioned);
assert(!withVersionedAssets(versioned,'release-next').includes('/codex-static/release-test/'));
assert.throws(()=>withVersionedAssets(html,'../escape'),/Invalid/);
console.log('Startup dependency and release URL utility contracts passed');
