import fs from 'node:fs/promises';
import ts from 'typescript';

export function patchBrowserAttachments(source) {
  if (source.includes('window.electronBridge.uploadFiles(t)')) return source;
  const ast = ts.createSourceFile('attachments.js', source, 99, true, ts.ScriptKind.JS);
  const fn = ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='Xll');
  if (!fn) throw Error('Browser attachment upload changed');
  source = source.slice(0,fn.getStart(ast)) + 'function Xll(e,t) {return window.electronBridge.uploadFiles(t);}' + source.slice(fn.end);
  const before = 'let i = C(m, g);';
  if(source.split(before).length!==2)throw Error('Dropped attachment routing changed');
  // The native controller already rejects results from an older draft generation.
  return source.replace(before, 'if (s !== `local`) {await T(r,o); C(m,g); return;} let i = C(m,g);');
}
export function patchBrowserAttachmentCapability(source) {
  if(source.includes('canCopyBrowserFileAttachments: !0,'))return source;
  const before = 'canCopyBrowserFileAttachments: !1,';
  if(source.split(before).length!==2)throw Error('Composer browser attachment capability changed');
  return source.replace(before,'canCopyBrowserFileAttachments: !0,');
}
if (process.argv[1]?.endsWith('browser-attachments-patch.mjs')) {
  const root='scratch/asar/webview/assets/';
  for(const [file,patch] of [['app-initial-6350d04672d0.js',patchBrowserAttachments],['app-primary-6f60e9ac4103.js',patchBrowserAttachmentCapability]]) {
    await fs.writeFile(root+file,patch(await fs.readFile(root+file,'utf8')));
  }
}
