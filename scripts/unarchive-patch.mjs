import ts from 'typescript';

// The RPC already returns the restored thread. Publish that metadata directly;
// a second hydration can race the notification and retain an archived cache.
export function patchUnarchive(source) {
  if (source.includes('codexWebUnarchiveMetadata')) return source;
  const tree = ts.createSourceFile('unarchive.js', source, 99, true, ts.ScriptKind.JS);
  const changes = [];
  let request = 0, context = 0, workflow = 0, notification = 0;
  function visit(node) {
    if (ts.isPropertyAssignment(node) && node.name.getText(tree) === 'unarchiveThread' &&
        node.initializer.getText(tree).includes('thread/unarchive')) {
      const arrow = node.initializer;
      if (!ts.isArrowFunction(arrow) || arrow.parameters.length !== 1) throw Error('Unarchive request changed');
      const id = arrow.parameters[0].name.getText(tree);
      const call = arrow.body.getText(tree);
      const manager = call.slice(0, call.indexOf('.manager.sendRequest'));
      if (!manager || !call.includes('.manager.sendRequest')) throw Error('Unarchive manager changed');
      changes.push([arrow.getStart(tree), arrow.end, `async (${id}) => {
        const codexWebUnarchiveMetadata = await ${call};
        ${manager}.threadStore.upsertConversationFromThread(codexWebUnarchiveMetadata.thread, 'stored');
        return codexWebUnarchiveMetadata;
      }`]);
      request++;
    }
    if (ts.isPropertyAssignment(node) && node.name.getText(tree) === 'loadUnarchivedThread') {
      const next = source.slice(node.end).match(/^\s*,/);
      if (!next) throw Error('Unarchive context layout changed');
      changes.push([node.getStart(tree), node.end + next[0].length, '']);
      context++;
    }
    if (ts.isFunctionDeclaration(node) && node.getText(tree).includes('Unarchive requested')) {
      const text = node.getText(tree);
      const match = text.match(/if\s*\(\s*(?:\()?\s*await\s+([\w$]+)\.loadUnarchivedThread\(([\w$]+)\),\s*!\1\.conversations\.has\(\2\)\)?\s*\)\s*throw new [\w$]+\(\2\);?/);
      if (!match) throw Error('Unarchive hydration changed');
      changes.push([node.getStart(tree), node.end, text.replace(match[0], `${match[1]}.deleteSuppressedArchivedConversationId(${match[2]});`)]);
      workflow++;
    }
    if (ts.isMethodDeclaration(node) && node.name.getText(tree) === 'handleThreadUnarchived' &&
        node.getText(tree).includes('this.threadStore.isCatalogHistoryEnabled')) {
      const id = node.parameters[0].name.getText(tree);
      const body = node.body.getText(tree).slice(1, -1);
      changes.push([node.body.getStart(tree), node.body.end, `{
        try { ${body} }
        catch (error) {
          this.logger.warning('Could not refresh unarchived thread', {
            safe: {conversationId: ${id}}, sensitive: {error}
          });
          this.events.emitThreadListInvalidated();
        }
      }`]);
      notification++;
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  if ([request, context, workflow, notification].some(count => count !== 1)) throw Error('Native unarchive anchors changed');
  for (const [start, end, text] of changes.sort((a, b) => b[0] - a[0])) source = source.slice(0, start) + text + source.slice(end);
  return source;
}
