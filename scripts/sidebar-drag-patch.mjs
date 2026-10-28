import ts from 'typescript';

function once(source, before, after) {
  if (source.split(before).length !== 2) throw Error('Sidebar drag anchor changed: ' + before);
  return source.replace(before, after);
}

export function patchSidebarDrag(source) {
  if (source.includes('function codexWebProjectReorderRect(')) return source;
  const tree = ts.createSourceFile('initial.js', source, 99, true, ts.ScriptKind.JS);
  const edits = [];
  function change(name, edit) {
    const node = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    if (!node) throw Error('Sidebar drag function changed: ' + name);
    edits.push({start: node.getStart(tree), end: node.end, text: edit(node.getText(tree))});
  }
  change('kI', body => {
    // Folder order must leave recency sorting just like a manually reordered chat.
    for (const list of ['o', 'a']) {
      const before = `${list}.some((e) => e.startsWith(\`content-tab:\`))`;
      const after = `${list}.some((e) => e.startsWith(\`content-tab:\`) || e.startsWith(\`codex:project:\`) || e.startsWith(\`chatgpt:project:\`))`;
      if (list === 'a') {
        if (body.split(before).length !== 3) throw Error('Pinned order comparisons changed');
        body = body.replace(before, after);
      } else body = once(body, before, after);
    }
    return body;
  });
  change('mis', body => once(body, 'overRect: e.over.rect,', 'overRect: codexWebProjectReorderRect(e),'));
  change('Lbs', body => once(body, 'targetRect: r.rect,', 'targetRect: codexWebProjectReorderRect(e),'));
  change('RIo', body => once(body, '? zIo', '? 0'));
  change('PIo', body => once(body,
    't.projectDropZone === `project-pagination`)',
    '(t.projectDropZone === `project-pagination` || t.projectDropZone === `project-row`))'));
  for (const edit of edits.sort((a,b) => b.start-a.start)) source = source.slice(0,edit.start)+edit.text+source.slice(edit.end);
  return source + `
function codexWebProjectReorderRect(event) {
  const active = event.active.data.current;
  const over = event.over.data.current;
  const projectId = over?.projectId ?? over?.project?.projectId;
  if ((active?.kind === 'sidebar-group' || active?.project != null) && projectId != null) {
    const row = document.querySelector('[data-app-action-sidebar-project-id="' + CSS.escape(projectId) + '"]');
    if (row) return row.getBoundingClientRect();
  }
  return event.over.rect;
}
`;
}
