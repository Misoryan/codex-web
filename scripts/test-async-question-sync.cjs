const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');

async function main() {
  const {patchAsyncQuestionSync, patchAsyncQuestionGroups} = await import('./async-question-sync-patch.mjs');
  const initial = fs.readFileSync('scratch/asar/webview/assets/app-initial-6350d04672d0.js', 'utf8');
  const shared = patchAsyncQuestionGroups(fs.readFileSync('scratch/asar/webview/assets/app-shared-8bd9d0399038.js', 'utf8'));
  assert.equal(patchAsyncQuestionGroups(shared), shared);
  const patched = patchAsyncQuestionSync(initial);
  assert.equal(patchAsyncQuestionSync(patched), patched);
  function extract(source, names) {
    const tree = ts.createSourceFile('native.js', source, 99, true, ts.ScriptKind.JS);
    return names.map(name => {
      const fn = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
      assert(fn, name);
      return fn.getText(tree);
    }).join('\n');
  }
  const helpers = extract(shared, ['exr', 'qH', 'Bmn', 'F5t', 'Vmn', 'tV', 'codexWebLatestAsyncQuestion']);
  const replyParser = {
    L5t: '<send_user_message_question_reply>', R5t: '</send_user_message_question_reply>',
    B5t: {safeParse: data => ({success: true, data})},
  };
  const pending = vm.runInNewContext(`${helpers}\n${extract(shared, ['V5t', 'W5t', 'G5t', 'K5t', 'q5t', 'J5t', 'Y5t', 'X5t'])}\nV5t`, replyParser);
  const hostId = 'local', threadId = 'fixture-thread', turnId = 'fixture-turn';
  const key = {hostId, threadId, entityKey: `turn:${turnId}`};
  const questionId = index => JSON.stringify(['request_user_input_async', 'question-call', index]);
  const questionItem = {id: 'question-call', type: 'agentMessage', questions: [{title: 'Entry?', options: ['Lite', 'Full']}, {title: 'Page?', options: ['Initial', 'Older']}]};
  const earlierQuestion = {...questionItem, id: 'earlier-question'};
  const replyItem = (indexes, sourceId = questionItem.id) => ({id: 'reply', type: 'userMessage', content: [{type: 'text', text: `<send_user_message_question_reply>\n${JSON.stringify(indexes.map(index => ({questionItemId: JSON.stringify(['request_user_input_async', sourceId, index]), question: 'Question', answer: 'Answer'})))}\n</send_user_message_question_reply>`}]});
  const status = items => pending({turnId, status: 'inProgress', items});
  assert.equal(status([earlierQuestion, questionItem, replyItem([0, 1])]), null, 'Answering the current request clears the sidebar even if an earlier request was unanswered');
  assert.deepEqual(Array.from(status([earlierQuestion, questionItem, replyItem([0])]).questionIds), [questionId(1)], 'Unanswered questions in the current request remain pending');
  assert.deepEqual(Array.from(status([earlierQuestion, replyItem([0, 1], earlierQuestion.id), questionItem]).questionIds), [questionId(0), questionId(1)], 'An earlier reply cannot answer a later request');
  assert.deepEqual(Array.from(status([questionItem, {id: 'progress', type: 'agentMessage', text: 'Continuing'}]).questionIds), [questionId(0), questionId(1)], 'Progress alone cannot dismiss a current question');
  function fixture(source) {
    const values = new Map();
    const id = value => JSON.stringify(value);
    const scope = {
      get(token, params) {return values.get(token)?.get(id(params)) ?? (token === US ? [] : token === DIt ? new Map() : null);},
      set(token, params, value) {
        if (typeof value === 'function') value = value(this.get(token, params));
        let map = values.get(token);
        if (!map) values.set(token, map = new Map());
        map.set(id(params), value);
      },
    };
    const token = () => {const object = {}; object.resolve = (_, __, params) => ({get: () => scope.get(object, params)}); return object;};
    const US = token(), WS = token(), DIt = token();
    const reconcile = vm.runInNewContext(`${helpers}\n${extract(source, ['mIt', 'HS'])}\nconst yue=exr, zie=Vmn; mIt`, {
      Map, Set, Date, JSON, US, WS, DIt, Pc: (_, action) => action(),
      ...replyParser, jue: () => false,
    });
    reconcile(scope, key, {turnId, items: [questionItem]});
    scope.set(DIt, hostId, new Map([[threadId, {selectedQuestionKey: {...key, itemId: questionId(0)}, questionIds: [questionId(0), questionId(1)]}]]));
    const selection = () => scope.get(DIt, hostId).get(threadId) ?? null;
    const state = index => scope.get(WS, {...key, itemId: questionId(index)});
    const answer = (indexes, {steering = false, status = 'accepted', ordinary = false} = {}) => {
      const text = ordinary ? 'Lite' : `<send_user_message_question_reply>\n${JSON.stringify(indexes.map(index => ({questionItemId: questionId(index), question: questionItem.questions[index].title, answer: questionItem.questions[index].options[0]})))}\n</send_user_message_question_reply>`;
      const content = [{type: 'text', text}];
      reconcile(scope, key, {turnId, items: [questionItem, steering ? {id: 'reply', type: 'steeringUserMessage', input: content, status} : {id: 'reply', type: 'userMessage', content}]});
    };
    return {answer, selection, state, replaceItems(items) {reconcile(scope, key, {turnId, items});}, setDraft(index, draft) {const params = {...key, itemId: questionId(index)}; scope.set(WS, params, {...state(index), draft});}};
  }
  if (!initial.includes('CODEX_WEB_QUESTION_SYNC')) {
    const old = fixture(initial);
    old.answer([0, 1]);
    assert(old.selection(), 'The shipped reconciler leaves an answered question selected');
  }
  const complete = fixture(patched);
  complete.answer([0, 1]);
  assert.equal(complete.selection(), null, 'Answers accepted on another client close the question composer');
  const partial = fixture(patched);
  partial.setDraft(1, 'My unsent choice');
  partial.answer([0]);
  assert.deepEqual(JSON.parse(JSON.stringify(partial.selection().questionIds)), [questionId(1)]);
  assert.equal(partial.selection().selectedQuestionKey.itemId, questionId(1));
  assert.equal(partial.state(1).draft, 'My unsent choice');
  assert.equal(partial.state(0).lastSubmission, 'Lite');
  for (const status of ['pending', 'sending', 'failed']) {
    const pending = fixture(patched);
    pending.answer([0, 1], {steering: true, status});
    assert.equal(pending.selection().questionIds.length, 2, 'An unaccepted response cannot dismiss a question');
  }
  const accepted = fixture(patched);
  accepted.answer([0, 1], {steering: true});
  assert.equal(accepted.selection(), null);
  const ordinary = fixture(patched);
  ordinary.answer([0, 1], {ordinary: true});
  assert.equal(ordinary.selection().questionIds.length, 2, 'Ordinary messages cannot dismiss unrelated questions');
  const superseded = fixture(patched);
  superseded.replaceItems([questionItem, {...questionItem, id: 'later-question'}]);
  assert.equal(superseded.selection(), null, 'A later request closes the selection for the earlier request');
  assert.equal(superseded.state(0), null, 'A replaced question cannot leave an old draft in the composer');
  const report = {passed: true, baselineReproduced: !initial.includes('CODEX_WEB_QUESTION_SYNC'), scenarios: ['accepted reply closes selected composer', 'partial reply selects remaining question', 'unsent draft retained', 'pending and failed replies stay pending', 'accepted steering reply clears composer', 'ordinary message leaves questions open', 'current question group controls sidebar input', 'earlier replies cannot answer later questions', 'later request removes the earlier composer selection']};
  fs.mkdirSync('runtime/public-connection', {recursive: true});
  fs.writeFileSync('runtime/public-connection/question-tests.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
main().catch(error => {console.error(error); process.exitCode = 1;});
