const fs = require('node:fs'), path = require('node:path');
const {createHash}=require('node:crypto');
const ts=require('typescript');
const {patchCodeReviewPerformance,patchCodeReviewMergeReadiness,patchCodeReviewSequentialMerges}=require('./code-review-performance-patch.cjs');
function patch(source) {
  const replacements = [
    ['command:\n      process.platform === `win32`\n        ? a.command\n        : C.default.join(n.path, a.command),', 'command: e ? a.command : process.execPath,\n    args: e ? a.args : [C.default.join(n.path, `server.mjs`)],'],
  ];
  for (const [before, after] of replacements) {
    if (source.includes(after) && !source.includes(before)) continue;
    if (source.split(before).length !== 2) throw Error('App tools startup anchor changed: ' + before);
    source = source.replace(before, after);
  }
  return source;
}
function patchNodeRuntime(source) {
  const tree=ts.createSourceFile('runtime.js',source,99,true,ts.ScriptKind.JS);
  const node=tree.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='Kt');
  if(!node?.body || (!node.getText(tree).includes('executableName')&&!node.getText(tree).includes('process.execPath')))throw Error('Bundled Node resolver changed');
  return source.slice(0,node.body.getStart(tree))+'{return process.execPath;}'+source.slice(node.body.end);
}
function bundleCodeReview(marketplace) {
  const directory=path.join(marketplace,'plugins/code-review');
  const file=path.join(directory,'.mcp.json');
  const config=JSON.parse(fs.readFileSync(file,'utf8'));
  const server=config.mcpServers?.['code-review'];
  if(!server||!fs.existsSync(path.join(directory,'server.mjs')))throw Error('Official code review bundle is incomplete');
  const serverFile=path.join(directory,'server.mjs');
  fs.writeFileSync(serverFile,patchCodeReviewPerformance(fs.readFileSync(serverFile,'utf8')));
  const uiFile=path.join(directory,'assets/pull-requests.js');
  fs.writeFileSync(uiFile,patchCodeReviewSequentialMerges(patchCodeReviewMergeReadiness(fs.readFileSync(uiFile,'utf8'))));
  // Name the two public UI resources by their contents so browser hosts can
  // reuse them across PR navigation without caching any account or PR data.
  const htmlFile=path.join(directory,'assets/pull-requests.html');
  for(const extension of ['js','css']) {
    const asset=fs.readFileSync(path.join(directory,'assets/pull-requests.'+extension));
    const uri='ui://pull-requests/app-'+createHash('sha256').update(asset).digest('hex')+'.'+extension;
    const pattern=new RegExp('ui://pull-requests/app(?:-[a-f0-9]{64})?\\.'+extension,'g');
    for(const target of [serverFile,htmlFile]) {
      const text=fs.readFileSync(target,'utf8');
      if([...text.matchAll(pattern)].length!==1)throw Error('Code Review static resource URI changed: '+target);
      fs.writeFileSync(target,text.replace(pattern,uri));
    }
  }
  server.command=process.execPath;
  server.args=['./server.mjs'];
  const bytes=JSON.stringify(config,null,2)+'\n';
  fs.writeFileSync(file,bytes);
  const manifest=path.join(directory,'.codex-plugin/plugin.json');
  const plugin=JSON.parse(fs.readFileSync(manifest,'utf8'));
  const version=plugin.version.replace(/-web\.[a-f0-9]+$/,'');
  const digest=createHash('sha256').update(version).update(bytes).update(fs.readFileSync(serverFile)).update(fs.readFileSync(uiFile)).update(fs.readFileSync(htmlFile)).digest('hex');
  plugin.version=version+'-web.'+digest.slice(0,12);
  fs.writeFileSync(manifest,JSON.stringify(plugin,null,2)+'\n');
  const bundleId=path.join(marketplace,'.bundle-id');
  const originalId=fs.readFileSync(bundleId,'utf8').trim().replace(/^codex-web:([^:]+):[a-f0-9]+$/,'$1');
  fs.writeFileSync(bundleId,'codex-web:'+originalId+':'+digest+'\n');
}
function bundle(resources, target) {
  const source = path.join(resources, 'plugins');
  const definition = path.join(source, 'openai-bundled/plugins/codex-app-tools/.mcp.json');
  const config = JSON.parse(fs.readFileSync(definition, 'utf8'));
  if (!config.mcpServers?.codex_app || !fs.existsSync(path.join(path.dirname(definition), 'server.mjs')))
    throw Error('Official app tools bundle is incomplete');
  fs.cpSync(source, path.join(target, 'plugins'), { recursive: true });
  bundleCodeReview(path.join(target,'plugins/openai-bundled'));
  const build = path.join(target, '.vite/build');
  const names = fs.readdirSync(build).filter(name => /^main-.*\.js$/.test(name));
  if (names.length !== 1) throw Error('Expected exactly one native main bundle');
  const file = path.join(build, names[0]);
  fs.writeFileSync(file, patch(fs.readFileSync(file, 'utf8')));
  const runtime=fs.readdirSync(build).filter(name=>/^application-network-startup-.*\.js$/.test(name));
  if(runtime.length!==1)throw Error('Expected exactly one native runtime bundle');
  const runtimeFile=path.join(build,runtime[0]);
  fs.writeFileSync(runtimeFile,patchNodeRuntime(fs.readFileSync(runtimeFile,'utf8')));
}
module.exports = { patch, patchNodeRuntime, bundleCodeReview, bundle };
if (require.main === module) {
  bundle(process.argv[2] || 'scratch/ChatGPT.app/Contents/Resources', process.argv[3] || 'scratch/asar');
  console.log('Official app tools bundled with direct Node startup');
}
