import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';

// One renderer's unserializable notification must only close its subscription.
// Keep request/response failures and the native RPC serialization limits intact.
export function patchNativeRpcSubscriptions(source) {
  if (source.includes('codexWebSubscriptionFaultBoundary')) return source;
  const tree = ts.createSourceFile('native-rpc.js', source, 99, true, ts.ScriptKind.JS);
  const changes = [];
  function visit(node) {
    if (ts.isClassExpression(node) && node.members.some(member =>
      ts.isMethodDeclaration(member) && member.name.getText(tree) === 'subscribeConversation')) {
      const method = node.members.find(member =>
        ts.isMethodDeclaration(member) && member.name.getText(tree) === 'subscribe');
      const rpcPredicate = method?.getText(tree).match(/if\s*\(!([\w$]+)\(/)?.[1];
      if (!method || !rpcPredicate || !node.name || method.parameters.length !== 2)
        throw Error('Native RPC subscription layout changed');
      changes.push([method.getStart(tree), method.end, `static subscribe(callback, register) {
        if (!${rpcPredicate}(callback)) return register(callback);
        const stub = callback.dup();
        let cleanup, stopped = false;
        const subscription = new ${node.name.text}(() => {
          stopped = true;
          try { cleanup?.(); } finally { stub[Symbol.dispose](); }
        });
        try {
          cleanup = register((...args) => {
            if (stopped) return;
            try { stub(...args)[Symbol.dispose](); }
            catch (error) {
              subscription.unsubscribe();
              console.warn('[native-rpc] subscription delivery failed', {
                codexWebSubscriptionFaultBoundary: true,
                reason: error instanceof Error && error.message ===
                  'Serialization exceeded maximum allowed depth. (Does the message contain cycles?)'
                  ? 'serialization_depth' : 'delivery_failed'
              });
            }
          });
          // A source may emit its initial value before returning its cleanup.
          if (stopped) cleanup();
        } catch (error) {
          subscription.unsubscribe();
          throw error;
        }
        if (!stopped) stub.onRpcBroken(() => subscription.unsubscribe());
        return subscription;
      }`]);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  if (changes.length !== 1) throw Error('Expected one native RPC subscription boundary');
  const [start, end, text] = changes[0];
  return source.slice(0, start) + text + source.slice(end);
}

export async function patchNativeRpcSubscriptionFile(file = 'scratch/asar/.vite/build/src-BJv5Mk7n.js') {
  const before = await fs.readFile(file, 'utf8');
  const after = patchNativeRpcSubscriptions(before);
  if (after !== before) await fs.writeFile(file, after);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await patchNativeRpcSubscriptionFile(process.argv[2]);
