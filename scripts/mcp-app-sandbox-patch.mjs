import { build } from 'esbuild';
import path from 'node:path';
import ts from 'typescript';

export function patchCodeReviewGitHubScope(source) {
  const tree = ts.createSourceFile('asset.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const matches = [], accounts = [];
  function enclosingFunction(node) { while (node && !ts.isFunctionDeclaration(node)) node = node.parent; return node; }
  function visit(node) {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left) && ts.isCallExpression(node.right)) {
      const callback = node.right.arguments[1];
      if (callback && ts.isArrowFunction(callback)) {
        const text = callback.getText(tree), owner = enclosingFunction(node);
        if (text.includes('JSON.stringify') && (text.includes('accountId') || text.includes('result.account.login.toLowerCase()')) && owner?.getText(tree).includes('code-review-pinned-prs-v1')) matches.push(callback);
        if (text.includes('GitHub account source unavailable') && text.includes('gh-current-user')) accounts.push({query:node.left.text,initialize:owner?.name?.text});
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  if (matches.length === 1 && matches[0].getText(tree).includes('result.account.login.toLowerCase()')) return source;
  if (matches.length !== 1 || accounts.length !== 1 || !accounts[0].initialize || !matches[0].getText(tree).includes('accountId')) throw Error('Code Review account scope changed');
  const node = matches[0];
  return source.slice(0,node.getStart(tree)) + `({get})=>{${accounts[0].initialize}();const result=get(${accounts[0].query},{hostId:"local",hostname:"github.com",provider:"github-cli"}).data;return result?.status==="success"?JSON.stringify(["github-cli",result.account.hostname,result.account.login.toLowerCase()]):null;}` + source.slice(node.end);
}

export function patchBrowserLocalImages(source) {
  const tree = ts.createSourceFile('asset.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const functions = tree.statements.filter(ts.isFunctionDeclaration).filter(node => node.name?.text === 'pJr');
  if (functions.length !== 1 || !functions[0].getText(tree).includes('vscode-webview:')) throw Error('Local image path resolver changed');
  const node = functions[0];
  if (node.getText(tree).includes('"/@fs/"')) return source;
  const at = node.body.getStart(tree) + 1;
  return source.slice(0, at) + '\nif(typeof e === "string" && e.startsWith("/@fs/")) return null;\n' + source.slice(at);
}

export function patchMcpAppFrames(source) {
  if (/wr\s*=\s*`iframe`/.test(source)) return source;
  if ([...source.matchAll(/wr\s*=\s*`webview`/g)].length !== 1) throw Error('MCP app frame creation changed');
  return source.replace(/wr\s*=\s*`webview`/, 'wr = `iframe`');
}

export function patchMcpAppSurface(source) {
  if (source.includes('data-browser-mcp-header')) return source;
  const tree = ts.createSourceFile('asset.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const view = tree.statements.filter(ts.isFunctionDeclaration).find(node => node.name?.text === 'E');
  const initial = tree.statements.filter(ts.isImportDeclaration).find(node => node.moduleSpecifier.text.startsWith('./app-initial-'));
  const edits = [];
  let background = false, header = false;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'b' && node.initializer?.getText(tree).replace(/\s/g, '') === 'l??void0') {
      edits.push([node.initializer.getStart(tree), node.initializer.end, 'l??"var(--app-color-background-surface,var(--color-surface-tertiary))"']);
      background = true;
    }
    if (ts.isCallExpression(node) && node.arguments[0]?.getText(tree) === '`header`' && ts.isObjectLiteralExpression(node.arguments[1])) {
      const props = node.arguments[1].properties;
      if (props.some(prop => prop.name?.getText(tree) === '"data-mcp-extension-header"')) {
        const child = props.find(prop => prop.name?.getText(tree) === 'children')?.initializer;
        if (!child) throw Error('MCP app header content changed');
        edits.push([node.getStart(tree), node.end, `(0,O.jsx)("header",{className:"h-toolbar shrink-0 px-2 select-none","data-browser-mcp-header":!0,children:${child.getText(tree)}})`]);
        header = true;
      }
    }
    ts.forEachChild(node, visit);
  }
  if (!view?.body || !initial) throw Error('MCP app global view changed');
  visit(view);
  if (!background || !header) throw Error('MCP app global surface changed');
  for (const [start, end, value] of edits.sort((a, b) => b[0] - a[0])) source = source.slice(0, start) + value + source.slice(end);
  return source;
}

export function patchMcpAppWorkspace(source) {
  if (source.includes('s.pathname.startsWith("/mcp-app/") ? null : f') && source.includes('if(e.pathname.startsWith("/mcp-app/"))return true;')) return source;
  const tree = ts.createSourceFile('asset.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const node = tree.statements.filter(ts.isFunctionDeclaration).find(node => node.name?.text === 'Xmc');
  if (!node || !node.getText(tree).includes('persistentWorkspace')) throw Error('MCP app route workspace changed');
  const original = node.getText(tree);
  const changed = original.includes('s.pathname.startsWith("/mcp-app/") ? null : f') ? original : original.replace('let p = f,', 'let p = s.pathname.startsWith("/mcp-app/") ? null : f,');
  if (!changed.includes('s.pathname.startsWith("/mcp-app/") ? null : f')) throw Error('MCP app route session selection changed');
  source = source.slice(0, node.getStart(tree)) + changed + source.slice(node.end);
  return source.replace(/function zIn\(e\)\s*\{/, 'function zIn(e){if(e.pathname.startsWith("/mcp-app/"))return true;');
}

export function patchMcpAppHandshake(source) {
  if (source.includes('import("./mcp-app-sandbox.js")')) return source;
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
  if (matches.length !== 1) throw Error('MCP app sandbox handshake changed');
  const { node, bindings } = matches[0];
  const at = node.body.getStart(tree) + 1;
  return source.slice(0, at) + `\nif(n.webview instanceof HTMLIFrameElement && !new URL(n.sourceUrl).hostname.startsWith("codex-inline-visualization-")) return (await import("./mcp-app-sandbox.js")).connect({...n,hostApiHandlers:${bindings.hostApiHandlers}});\n` + source.slice(at);
}

export async function buildMcpAppSandbox(outdir) {
  await build({ entryPoints: ['src/browser/mcp-app-sandbox.ts'], outfile: path.join(outdir, 'mcp-app-sandbox.js'), bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true, nodePaths: process.env.NODE_PATH?.split(path.delimiter) });
}
