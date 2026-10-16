import ts from 'typescript';

function change(source, name, edit) {
  const tree = ts.createSourceFile('native.js', source, 99, true, ts.ScriptKind.JS);
  const fn = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  if (!fn) throw Error(`Native follow-up function changed: ${name}`);
  return source.slice(0, fn.getStart(tree)) + edit(fn.getText(tree)) + source.slice(fn.end);
}

export function patchFollowupSubmission(source) {
  source = change(source, 'EQe', body => body.replace('(n ?? `queue`)', '(n ?? `steer`)'));
  return change(source, 'Put', body => {
    if (body.includes('CODEX_WEB_DIRECT_STEER')) return body;
    const anchor = 'acceptLocally:\n                      !ke &&';
    if (body.split(anchor).length !== 2) throw Error('Native local acceptance changed');
    return body.replace(anchor, 'acceptLocally:\n                      he === `queue` && /* CODEX_WEB_DIRECT_STEER */\n                      !ke &&');
  });
}

export function patchInactiveSteer(source) {
  return change(source, 'nfn', body => {
    if (body.includes('CODEX_WEB_INACTIVE_STEER')) return body;
    const anchor = '    qun(e) ||';
    if (!body.includes(anchor)) throw Error('Native inactive steer classification changed');
    return body.replace(anchor, '    qun(e) || Jun(e) || /* CODEX_WEB_INACTIVE_STEER */');
  });
}
