import ts from 'typescript';
export function patchLiteHistory(source){
 const ast=ts.createSourceFile('history.js',source,99,true,ts.ScriptKind.JS),node=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='rB');
 if(!node||!node.getText(ast).includes('thread/items/list repeated cursor'))throw Error('History loader changed');
 let body=node.getText(ast);
 body=body.replace('  let f = await e.sendRequest(', '  t = Math.min(t,100);\n  let f = await e.sendRequest(');
 if(!body.includes('t = Math.min(t,100)'))throw Error('History limit changed');
 const parallel='b = (u || codexWebOpeningPage)\n      ?';
 if(!body.includes(parallel))throw Error('History parallel loading changed');
 body=body.replace(parallel, 'b = (u || codexWebOpeningPage || f.data.length <= Math.min(o ?? 5,5))\n      ?');
 return source.slice(0,node.getStart(ast))+body+source.slice(node.end);
}
