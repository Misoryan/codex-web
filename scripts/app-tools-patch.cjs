const fs = require('node:fs'), path = require('node:path');
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
function bundle(resources, target) {
  const source = path.join(resources, 'plugins');
  const definition = path.join(source, 'openai-bundled/plugins/codex-app-tools/.mcp.json');
  const config = JSON.parse(fs.readFileSync(definition, 'utf8'));
  if (!config.mcpServers?.codex_app || !fs.existsSync(path.join(path.dirname(definition), 'server.mjs')))
    throw Error('Official app tools bundle is incomplete');
  fs.cpSync(source, path.join(target, 'plugins'), { recursive: true });
  const build = path.join(target, '.vite/build');
  const names = fs.readdirSync(build).filter(name => /^main-.*\.js$/.test(name));
  if (names.length !== 1) throw Error('Expected exactly one native main bundle');
  const file = path.join(build, names[0]);
  fs.writeFileSync(file, patch(fs.readFileSync(file, 'utf8')));
}
module.exports = { patch, bundle };
if (require.main === module) {
  bundle(process.argv[2] || 'scratch/ChatGPT.app/Contents/Resources', process.argv[3] || 'scratch/asar');
  console.log('Official app tools bundled with direct Node startup');
}
