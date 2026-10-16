const codexWebSubagentReads = new WeakMap();

function codexWebHasSubagentHistory(conversation, parentTurnIds = conversation?.codexWebParentTurnIds ?? []) {
  const inherited = new Set(parentTurnIds);
  return conversation != null && __CODEX_WEB_LOADED_TURNS__(conversation, __CODEX_WEB_MERGE_POLICY__).some(turn => !__CODEX_WEB_PLACEHOLDER_TURN__(turn) && !inherited.has(turn.turnId));
}

function codexWebApplySubagentPreviewState(store, threadId, result) {
  store.updateConversationState(threadId, state => {
    state.codexWebParentTurnIds = result.parentTurnIds;
    state.codexWebSubagentPreview = true;
    state.paginatedHistory ??= {itemsBackwardsCursor: null};
  });
}

function codexWebReadSubagentPreview(store, threadId) {
  let reads = codexWebSubagentReads.get(store);
  if (!reads) {
    reads = new Map();
    codexWebSubagentReads.set(store, reads);
  }
  const key = `${store.hydrationGeneration}:${threadId}`;
  if (reads.has(key)) return reads.get(key);
  const pending = codexWebFetchSubagentPreview(store, threadId);
  reads.set(key, pending);
  const remove = () => { if (reads.get(key) === pending) reads.delete(key); };
  pending.then(remove, remove);
  return pending;
}

async function codexWebFetchSubagentPreview(store, threadId) {
  const options = {priority: 'interactive', source: 'collab_hydration'};
  const conversation = store.getConversation(threadId);
  const preserveHistory = conversation?.codexWebSubagentPreview === true && codexWebHasSubagentHistory(conversation);
  const threadStatusAtReadStart = store.threadsById.get(threadId)?.status;
  const sendRequest = store.params.requestClient.sendRequest.bind(store.params.requestClient);
  const metadata = store.readThread(threadId, {includeTurns: false, requestOptions: options});
  const parentId = __CODEX_WEB_PARENT_THREAD__(conversation);
  const parentIds = conversation?.codexWebParentTurnIds ?? (parentId != null
    ? codexWebReadParentTurnIds(sendRequest, parentId, options)
    : metadata.then(value => codexWebReadParentTurnIds(sendRequest, __CODEX_WEB_PARENT_THREAD__(value.thread), options)));
  const [response, page, parentTurnIds] = await Promise.all([
    metadata,
    preserveHistory ? null : __CODEX_WEB_PAGE_LOADER__(
      {sendRequest, getConversation: store.getConversation.bind(store)},
      100, __CODEX_WEB_MERGE_POLICY__, threadId, null, null, 5, options,
      undefined, undefined, true,
    ),
    parentIds,
  ]);
  return {
    preserveHistory: codexWebHasSubagentHistory(conversation, parentTurnIds),
    threadStatusAtReadStart,
    response: {...response, thread: {...response.thread, turns: page?.response.data.slice().reverse() ?? []}},
    itemsPaginationByTurnId: page?.itemsPaginationByTurnId,
    parentTurnIds,
    turnsPagination: page == null ? undefined : {
      olderCursor: page.response.nextCursor,
      oldestLoadedTurnId: page.response.data.at(-1)?.id ?? null,
      isLoadingOlder: false,
      hasLoadedOldest: page.response.nextCursor == null,
    },
  };
}

async function codexWebReadParentTurnIds(sendRequest, parentId, options) {
  if (parentId == null) return [];
  const ids = [], seen = new Set();
  let cursor = null;
  do {
    if (seen.has(cursor)) throw Error('Parent history returned a repeated cursor');
    seen.add(cursor);
    const page = await sendRequest('thread/turns/list', {
      threadId: parentId, cursor, limit: 100, sortDirection: 'desc', itemsView: 'notLoaded',
    }, options);
    ids.push(...page.data.map(turn => turn.id));
    cursor = page.nextCursor;
  } while (cursor != null);
  return ids;
}
