import fs from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import ts from 'typescript';

export function patchVisualizationHandshake(source) {
  if (source.includes('import("./visualization-sandbox.js")')) return source;
  const tree = ts.createSourceFile('asset.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const matches = [];
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.body && node.parameters.length === 1 && ts.isObjectBindingPattern(node.parameters[0].name)) {
      const bindings = Object.fromEntries(node.parameters[0].name.elements.map(element => [(element.propertyName ?? element.name).text, element.name.text]));
      if (bindings.hostApiHandlers && bindings.assertActive && bindings.n) matches.push({ node, bindings });
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  if (matches.length !== 1) throw Error('Visualization sandbox handshake changed');
  const { node, bindings: b } = matches[0];
  const insertion = node.body.getStart(tree) + 1;
  const code = `\nif (n.webview instanceof HTMLIFrameElement && new URL(n.sourceUrl).hostname.startsWith("codex-inline-visualization-")) {
    return (await import("./visualization-sandbox.js")).connect({ ...n, hostApiHandlers: ${b.hostApiHandlers} });
  }\n`;
  return source.slice(0, insertion) + code + source.slice(insertion);
}

export function patchVisualizationFrames(source) {
  if (/scheme:\s*"https"/.test(source)) return source;
  if ([...source.matchAll(/scheme:\s*a\b/g)].length !== 1 || !source.includes('G8t as a')) throw Error('Visualization frame scheme changed');
  return source.replace('G8t as a,', '').replace(/scheme:\s*a\b/, 'scheme:"https"');
}

export function patchVisualizationEntry(source) {
  const tree = ts.createSourceFile('asset.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const matches = [];
  function visit(node) {
    if (ts.isObjectLiteralExpression(node) && node.properties.length === 2 && ts.isSpreadAssignment(node.properties[0]) && ts.isPropertyAssignment(node.properties[1]) && node.properties[1].name.getText(tree) === 'scheme') matches.push(node.properties[1].initializer);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  if (matches.length !== 1) throw Error('Visualization entry scheme changed');
  const scheme = matches[0];
  return source.slice(0, scheme.getStart(tree)) + '"https"' + source.slice(scheme.end);
}

export async function buildVisualizationSandbox(outdir) {
  await build({ entryPoints: ['src/browser/visualization-sandbox.ts'], outfile: path.join(outdir, 'visualization-sandbox.js'), bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true, loader: { '.js': 'text' }, plugins: [{ name: 'raw-host-bridge', setup(builder) {
    builder.onResolve({ filter: /\?raw$/ }, args => ({ path: path.resolve(args.resolveDir, args.path.slice(0, -4)), namespace: 'raw' }));
    builder.onLoad({ filter: /.*/, namespace: 'raw' }, async args => ({ contents: await fs.readFile(args.path, 'utf8'), loader: 'text' }));
  } }] });
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const root = path.resolve(process.argv[2] ?? 'scratch/asar/webview/assets');
  const names = await fs.readdir(root);
  const initial = 'mcp-sandbox-rpc-31ca1981dbc5.js';
  const frames = names.find(name => /^visualization-thread-frames-.*\.js$/.test(name));
  const primary = 'visualization-directive-renderer-4fb52b2afe5f.js';
  if (!initial || !frames || !primary) throw Error('Visualization assets missing');
  await buildVisualizationSandbox(root);
  await fs.writeFile(path.join(root, initial), patchVisualizationHandshake(await fs.readFile(path.join(root, initial), 'utf8')));
  await fs.writeFile(path.join(root, frames), patchVisualizationFrames(await fs.readFile(path.join(root, frames), 'utf8')));
  await fs.writeFile(path.join(root, primary), patchVisualizationEntry(await fs.readFile(path.join(root, primary), 'utf8')));
}
