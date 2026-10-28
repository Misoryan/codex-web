import fs from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

function once(source, before, after) {
  if (source.split(before).length !== 2) throw Error('Automation scheduler anchor changed: ' + before.slice(0, 100));
  return source.replace(before, after);
}

export function patchAutomationScheduler(source) {
  if (source.includes('codexWebHeadlessScheduler')) return source;
  const tree = ts.createSourceFile('main.js', source, 99, true, ts.ScriptKind.JS);
  const edits = [];
  function change(name, edit) {
    const node = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    if (!node) throw Error('Automation function changed: ' + name);
    edits.push({start: node.getStart(tree), end: node.end, text: edit(node.getText(tree))});
  }
  change('Pl', body => {
    body = once(body, '    k = !1,\n', '');
    body = once(body, '    P = new Map(),\n', '');
    body = once(body, '                      heartbeatThreadCollaborationModes: P,\n', '');
    body = once(body, '        P.clear(),\n', '');
    body = once(body, '        e.collaborationMode != null && P.set(t, e.collaborationMode),\n', '');
    body = once(body, 'if (!D && k)', 'if (!D && !T)');
    body = once(body, '          let _ = a.getConnection(d.hostConfig.id),', '          const connection = a.getConnection(d.hostConfig.id);\n          await connection.ensureReady();\n          j.signal.throwIfAborted();\n          let _ = connection,');
    // UI capability updates can wake the scheduler, but cannot suspend a server.
    return once(body, 'T || k === e || ((k = e), E && e && I());', 'if (!T && E && e) I();');
  });
  change('Ul', body => {
    body = once(body, '  heartbeatThreadCollaborationModes: l,\n', '');
    const begin = body.indexOf('  let _ = El(Zl(l, t.targetThreadId), await Bl(p));');
    const end = body.indexOf('  let v = await $l(', begin);
    if (begin < 0 || end < 0) throw Error('Heartbeat mode gate changed');
    const gate = body.slice(begin, end).replace(
      '  let _ = El(Zl(l, t.targetThreadId), await Bl(p));',
      '  const resumedThread = await Kl({thread: h, appServerConnection: r});\n  o();\n  let _ = El(resumedThread.collaborationMode, await Bl(p));',
    ).replace('waiting for renderer mode state', 'waiting for saved mode state');
    body = body.slice(0, begin) + body.slice(end);
    body = once(body, '  let y = Il({ automation: t, now: n });', gate + '  o();\n  let y = Il({ automation: t, now: n });');
    return once(body, '      thread: h,\n      appServerConnection: r,\n      collaborationMode:', '      thread: h,\n      resumedThread,\n      appServerConnection: r,\n      collaborationMode:');
  });
  change('Gl', body => {
    body = once(body, '  thread: n,', '  thread: n,\n  resumedThread,');
    return once(body, 'await Kl({ thread: n, appServerConnection: r })', 'resumedThread ?? await Kl({ thread: n, appServerConnection: r })');
  });
  change('Kl', body => once(body, '    ...n.thread,', '    ...n.thread,\n    collaborationMode: n.collaborationMode,'));
  change('Zl', () => '');
  for (const edit of edits.sort((a, b) => b.start - a.start)) source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
  const startup = `    B.add(
      oi({
        startupPhases: x,
        phase: \`first_content_visible\`,
        fallback: { phase: \`renderer_ready\`, timeoutMs: ai },
        start: () => {
          _t.start();
        },
        onError: (e) => {
          f.n().warning(\`Failed to start the automation scheduler\`, {
            safe: {},
            sensitive: { error: e },
          });
        },
      }),
    ),`;
  // The bridge is a long-lived server; a browser lifecycle must not own its clock.
  source = once(source, startup, '    _t.start(),\n    xl().info(`Headless automation scheduler started`, {safe: {tickMs: dl}, sensitive: {}}),');
  return source + '\n// codexWebHeadlessScheduler\n';
}

export async function patchAutomationSchedulerFile(root = 'scratch/asar') {
  const file = path.join(root, '.vite/build/main-CqEoQDOU.js');
  await fs.writeFile(file, patchAutomationScheduler(await fs.readFile(file, 'utf8')));
}
