import fs from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

// Discover static imports at build time so the browser can fetch them together.
export async function withStartupPreloads(html, root, basePath) {
  const directory = path.join(root, 'assets');
  const names = await fs.readdir(directory);
  const locales = {};
  const entries = ['app-initial-'].flatMap(prefix => {
    const matches = names.filter(name => name.startsWith(prefix) && name.endsWith('.js'));
    if (!matches.length) throw Error(`Missing ${prefix} entry`);
    return matches;
  });
  const seen = new Set();
  const visit = async name => {
    if (seen.has(name)) return;
    if (name.includes('/') || name.includes('\\')) throw Error('Unexpected nested startup module');
    seen.add(name);
    const source = await fs.readFile(path.join(directory, name), 'utf8');
    const tree = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
    if (name.startsWith('app-initial-')) {
      const collect = node => {
        if (ts.isPropertyAssignment(node) && ts.isStringLiteral(node.name)) {
          const tag = /^\.\.\/locales\/([a-zA-Z-]+)\.json$/.exec(node.name.text)?.[1];
          if (tag) {
            const findImport = child => {
              if (ts.isCallExpression(child) && child.expression.kind === ts.SyntaxKind.ImportKeyword) {
                const argument = child.arguments[0];
                if (argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) && /^\.\/[^/]+\.js$/.test(argument.text))
                  locales[tag] = `${basePath}assets/${argument.text.slice(2)}`;
              }
              ts.forEachChild(child, findImport);
            };
            findImport(node.initializer);
          }
        }
        ts.forEachChild(node, collect);
      };
      collect(tree);
    }
    for (const statement of tree.statements) {
      if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
      const dependency = statement.moduleSpecifier;
      if (dependency && ts.isStringLiteral(dependency) && dependency.text.startsWith('./') && dependency.text.endsWith('.js')) {
        await visit(dependency.text.slice(2));
      }
    }
  };
  for (const entry of entries) await visit(entry);
  html = html.replace(/<script data-locale-preload>[\s\S]*?<\/script>\s*/g, '');
  if (Object.keys(locales).length) {
    const script = await fs.readFile(new URL('./locale-preload.js', import.meta.url), 'utf8');
    html = html.replace('<head>', `<head><script data-locale-preload>window.__codexLocaleAssets=${JSON.stringify(locales)};\n${script}</script>`);
  }
  html = html.replace(/<!-- startup-preloads -->[\s\S]*?<!-- \/startup-preloads -->\s*/g, '');
  const existing = new Set([...html.matchAll(/<link\b[^>]*rel="modulepreload"[^>]*href="([^"]+)"[^>]*>/g)]
    .map(match => new URL(match[1], 'https://local' + basePath).pathname));
  const links = [...seen].map(name => `${basePath}assets/${name}`).filter(url => !existing.has(url))
    .map(url => `<link rel="modulepreload" crossorigin href="${url}">`).join('\n');
  return html.replace('</head>', `<!-- startup-preloads -->\n${links}\n<!-- /startup-preloads -->\n</head>`);
}

// A release URL must keep serving the same bytes for its entire cache lifetime.
export function withVersionedAssets(html, release) {
  if (!/^[a-z0-9][a-z0-9-]{0,100}$/.test(release)) throw Error('Invalid static release name');
  const base = html.includes('<base href="/lite/"') ? '/lite/' : '/';
  const versioned = url => {
    const absolute = new URL(url, 'https://local' + base);
    if (absolute.origin !== 'https://local') return url;
    absolute.pathname = absolute.pathname.replace(/^\/codex-static\/[a-z0-9-]+\//, '/');
    if (!/^\/(?:lite\/)?assets\//.test(absolute.pathname)) return url;
    return `/codex-static/${release}${absolute.pathname}${absolute.search}`;
  };
  html = html.replace(/\b(src|href)="([^"]+)"/g, (_, attribute, url) => `${attribute}="${versioned(url)}"`);
  html = html.replace(/window\.__codexStartupAssets=(\{[^;]+\});/, (_, json) =>
    'window.__codexStartupAssets=' + JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(json)).map(([url, size]) => [versioned(url), size]))) + ';');
  html = html.replace(/window\.__codexLocaleAssets=(\{[^;]+\});/, (_, json) =>
    'window.__codexLocaleAssets=' + JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(json)).map(([tag, url]) => [tag, versioned(url)]))) + ';');
  return html;
}
