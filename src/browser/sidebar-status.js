const sidebarHydration = new WeakMap();

export function subscribeSidebarSummary(client, key, listener) {
  let mounted = true;
  let requesting = false;
  let currentSummary = null;
  let runtimeStatus;
  let revision = 0;
  const known = status => status != null && status.type !== "notLoaded";
  const publish = () => {
    if (!mounted) return;
    listener(currentSummary && known(runtimeStatus)
      ? { ...currentSummary, threadRuntimeStatus: runtimeStatus }
      : currentSummary);
  };
  const requestStatus = () => {
    if (requesting || known(runtimeStatus)) return;
    requesting = true;
    queueMicrotask(() => {
      if (!mounted) return;
      let pending = sidebarHydration.get(client);
      if (!pending) sidebarHydration.set(client, pending = new Map());
      let request = pending.get(key.threadId);
      if (!request) {
        // Read only this row's metadata; unrelated slow reads cannot hold it up.
        request = Promise.resolve().then(() => client.readThread(key.threadId, {
          includeTurns: false,
          requestOptions: {priority: "background", source: "sidebar_status"},
        }));
        pending.set(key.threadId, request);
        const clear = () => { if (pending.get(key.threadId) === request) pending.delete(key.threadId); };
        request.then(clear, clear);
      }
      const atRead = revision;
      request.then(result => {
        if (!mounted || revision !== atRead) return;
        if (known(result.thread?.status)) runtimeStatus = result.thread.status;
        publish();
      }).catch(error => {
        console.warn("[sidebar-status] Could not read task metadata (runtime-v7)", error);
      }).finally(() => { requesting = false; });
    });
  };
  const stop = client.subscribe({
    type: "thread", key, field: "summary",
    listener(summary) {
      currentSummary = summary;
      if (known(summary?.threadRuntimeStatus)) {
        runtimeStatus = summary.threadRuntimeStatus;
        revision++;
      } else if (!known(runtimeStatus)) {
        runtimeStatus = client.getConversation(key.threadId)?.threadRuntimeStatus;
      }
      publish();
      requestStatus();
    },
  });
  const stopRuntime = client.subscribe({
    type: "thread", key, field: "runtimeStatus",
    listener(status) {
      if (!known(status)) return;
      runtimeStatus = status;
      revision++;
      publish();
    },
  });
  return () => { mounted = false; stopRuntime(); stop(); };
}

export function subscribeSidebarListState(client, key, listener) {
  let state = null;
  let summary = null;
  const publish = () => {
    if (state != null) {
      const status = summary?.threadRuntimeStatus;
      listener(state.resumeState === "needs_resume" && status != null && status.type !== "notLoaded"
        ? {...state, summary: {...state.summary, threadRuntimeStatus: status}, isConversationInProgress: status.type === "active"}
        : state);
      return;
    }
    listener(summary == null ? null : {
      summary, requests: [], hasUserMessage: false, pendingRequest: null,
      unansweredAsyncQuestions: null, latestTurnError: null,
      latestTurnId: null, latestTurnStatus: null, isResponseInProgress: false,
      isConversationInProgress: summary.threadRuntimeStatus?.type === "active",
      ephemeral: false, sideConversation: false, pendingHeartbeatStartedAtMs: null,
      latestTurnIsSilentHeartbeat: false, unreadMessageCount: 0,
      incompleteHistoryGeneration: null, turnsPagination: undefined,
      resumeState: "needs_resume", currentPermissions: undefined,
      latestThreadSettings: undefined, workspaceBrowserRoot: undefined,
    });
  };
  const stopState = client.subscribe({type: "thread", key, field: "listState", listener(value) {state = value; publish();}});
  const stopSummary = subscribeSidebarSummary(client, key, value => {summary = value; publish();});
  return () => { stopSummary(); stopState(); };
}

export function subscribeSidebarRpcListState(client, key, listener) {
  let requesting = false;
  return client.rpc.subscribe({
    type: "thread", key, field: "listState",
    listener(state) {
      listener(state);
      const status = state?.summary?.threadRuntimeStatus;
      if (requesting || (status != null && status.type !== "notLoaded")) return;
      requesting = true;
      let pending = sidebarHydration.get(client.rpc);
      if (!pending) sidebarHydration.set(client.rpc, pending = new Map());
      let request = pending.get(key.threadId);
      if (!request) {
        request = Promise.resolve().then(() => client.rpc.hydrateBackgroundThreads([key.threadId], {
          includeTurns: false, refreshExisting: true,
        }));
        pending.set(key.threadId, request);
        const clear = () => { if (pending.get(key.threadId) === request) pending.delete(key.threadId); };
        request.then(clear, clear);
      }
      request.catch(error => {
        console.warn("[sidebar-status-rpc] Could not read task metadata", error);
      }).finally(() => { requesting = false; });
    },
  });
}
