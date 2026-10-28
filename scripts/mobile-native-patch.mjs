import ts from 'typescript';

function replaceFunction(source, name, edit) {
  const ast = ts.createSourceFile('native.js', source, 99, true, ts.ScriptKind.JS);
  const fn = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  if (!fn) throw Error(`Native mobile function changed: ${name}`);
  return source.slice(0, fn.getStart(ast)) + edit(fn.getText(ast)) + source.slice(fn.end);
}

export function patchActivityEntrypoint(source) {
  if (source.includes('CODEX_WEB_ACTIVITY_ENTRYPOINT')) return source;
  return replaceFunction(source, 'X9r', body => {
    const anchor = 'return Y9r() ? `header_icon` : `off`;';
    if (!body.includes(anchor)) throw Error('Native activity entrypoint changed');
    return body.replace(anchor, 'Y9r(); return `header_icon`; /* CODEX_WEB_ACTIVITY_ENTRYPOINT */');
  });
}

export function patchActivityProjectIcon(source) {
  return replaceFunction(source, 'Yes', body => {
    if (body.includes('CODEX_WEB_ACTIVITY_PROJECT_ICON')) return body;
    const anchor = 'className: `text-tertiary group-hover:hidden`,\n          children: n,';
    if (body.split(anchor).length !== 2) throw Error('Native activity project label changed');
    return body.replace('(0, $2.jsx)(`span`,', '(0, $2.jsxs)(`span`,')
      .replace(anchor, 'className: `inline-flex items-center gap-1 text-tertiary`,\n          children: [(0, $2.jsx)(XV, {className: `icon-xxs shrink-0`, "aria-hidden": true}), (0, $2.jsx)(`span`, {children: n})], /* CODEX_WEB_ACTIVITY_PROJECT_ICON */');
  });
}

export function patchPickedImageMime(source) {
  if (source.includes('CODEX_WEB_PICKED_IMAGE_MIME')) return source;
  return replaceFunction(source, 'jdt', body => {
    const anchor = 'fsPath: e.fsPath,';
    if (body.split(anchor).length !== 3) throw Error('Native picked image metadata changed');
    // Uploaded paths have no extension; the original filename identifies the image format.
    return body.replaceAll(anchor, 'fsPath: e.label, /* CODEX_WEB_PICKED_IMAGE_MIME */');
  });
}

export function patchMobileNewTabs(source) {
  source = replaceFunction(source, 'Jfa', body => {
    if (body.includes('CODEX_WEB_MOBILE_NEW_TAB')) return body;
    const anchor = '  return e.get(Bo, { name: `browser.in-app` }).isCapable';
    if (!body.includes(anchor)) throw Error('Native new tab action changed');
    return body.replace(anchor, '  if (matchMedia("(max-width: 768px)").matches) return null; /* CODEX_WEB_MOBILE_NEW_TAB */\n' + anchor);
  });
  return replaceFunction(source, 'EMs', body => {
    if (body.includes('data-codex-web-new-tab')) return body;
    const anchor = '"aria-label": l,';
    if (body.split(anchor).length !== 2) throw Error('Native new tab button changed');
    return body.replace(anchor, anchor + '\n          "data-codex-web-new-tab": true,');
  });
}

export function patchMobileHistoryNavigation(source) {
  return replaceFunction(source, 'Gni', body => {
    if (body.includes('CODEX_WEB_MOBILE_HISTORY_NAVIGATION')) return body;
    const anchor = '  if (!t && n && !r) return null;';
    if (body.split(anchor).length !== 2) throw Error('Native history navigation changed');
    return body.replace(anchor, '  if (matchMedia("(max-width: 768px)").matches) return null; /* CODEX_WEB_MOBILE_HISTORY_NAVIGATION */\n' + anchor);
  });
}

export function patchSidebarPagination(source) {
  source = replaceFunction(source, '_Po', body => {
    if (body.includes('data-codex-web-pagination')) return body;
    if (body.split('ref: s,').length !== 4) throw Error('Native pagination sentinel changed');
    return body.replaceAll('ref: s,', 'ref: s, "data-codex-web-pagination": true,');
  });
  return replaceFunction(source, 'kPo', body => {
    if (body.includes('data-codex-web-infinite-list')) return body;
    const root = 'role: `list`,\n          tabIndex: -1,';
    const deps = 't[113] !== M ||';
    const cache = '(t[123] = gt))';
    const empty = '!(B && Ve)';
    for (const anchor of [root, deps, cache, empty, '(0, LPo.c)(124)']) {
      if (body.split(anchor).length !== 2) throw Error('Native navigation list changed: ' + anchor);
    }
    // Empty filtered pages still have a cursor; show the empty state after paging ends.
    return body.replace(empty, '!Ve')
      .replace('(0, LPo.c)(124)', '(0, LPo.c)(125)')
      .replace(deps, 't[124] !== z || ' + deps)
      .replace(cache, '(t[124] = z), ' + cache)
      .replace(root, '"data-codex-web-infinite-list": z === `infiniteScroll` ? true : undefined,\n          ' + root);
  });
}
