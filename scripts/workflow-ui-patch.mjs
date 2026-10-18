import ts from 'typescript';

export function patchWorkflowEntrypoint(source) {
  if (source.includes('CODEX_WEB_WORKFLOW_ENTRY')) return source;
  const ast = ts.createSourceFile('native.js', source, 99, true, ts.ScriptKind.JS);
  const node = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'les');
  if (!node) throw Error('Native sidebar entry changed');
  const body = node.getText(ast), anchor = '    y\n  );';
  if (body.split(anchor).length !== 2) throw Error('Native sidebar result changed');
  const next = body.replace(anchor, `    (0, Y2.jsxs)(Y2.Fragment, {children: [y, (0, Y2.jsx)(VF, {
      icon: XV, label: "工作流", onClick: () => { window.location.href = "/easecation-workflow/"; },
      "data-codex-workflow-entry": true
    })]}) /* CODEX_WEB_WORKFLOW_ENTRY */
  );`);
  return source.slice(0, node.getStart(ast)) + next + source.slice(node.end);
}
