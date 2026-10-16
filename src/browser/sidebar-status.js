const sidebarHydration = new WeakMap();

export function subscribeSidebarSummary(client, key, listener) {
  let mounted = true;
  let requested = false;
  const publish = summary => {
    if (!mounted) return;
    const status = summary?.threadRuntimeStatus;
    const cached = client.getConversation(key.threadId)?.threadRuntimeStatus;
    listener(summary && (status == null || status.type === "notLoaded") && cached
      ? { ...summary, threadRuntimeStatus: cached }
      : summary);
  };
  const stop = client.subscribe({
    type: "thread",
    key,
    field: "summary",
    listener(summary) {
      publish(summary);
      const status = summary?.threadRuntimeStatus;
      const cached = client.getConversation(key.threadId)?.threadRuntimeStatus;
      if (requested || (status != null && status.type !== "notLoaded") || (cached != null && cached.type !== "notLoaded")) return;
      requested = true;
      let batch = sidebarHydration.get(client);
      if (!batch) {
        batch = [];
        sidebarHydration.set(client, batch);
        queueMicrotask(() => {
          sidebarHydration.delete(client);
          const ids = [...new Set(batch.filter(entry => entry.mounted()).map(entry => entry.id))];
          if (!ids.length) return;
          // Native background hydration reads metadata without resuming a task.
          client.hydrateBackgroundThreads(ids, { includeTurns: false, refreshExisting: true }).then(() => {
            for (const entry of batch) entry.publish();
          }).catch(error => {
            console.warn("[sidebar-status] Could not read task metadata", error);
          });
        });
      }
      batch.push({ id: key.threadId, mounted: () => mounted, publish: () => publish(client.getThreadSummary(key.threadId)) });
    },
  });
  return () => { mounted = false; stop(); };
}
