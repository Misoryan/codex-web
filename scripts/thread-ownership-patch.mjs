export function patchIdleThreadOwnership(source) {
  if (source.includes('CODEX_WEB_IDLE_THREAD_RELEASE')) return source;
  const ttl = '(ken = 108e5),';
  const guard = '!this.params.streamState.ownsConversationHistoryStream(e)\n          ) {';
  if(source.split(ttl).length !== 2 || source.split(guard).length !== 2) throw Error('Native inactive thread ownership changed');
  return source.replace(ttl,'(ken = 1000), /* CODEX_WEB_IDLE_THREAD_RELEASE */').replace(guard,
    '!this.params.streamState.ownsConversationHistoryStream(e) ||\n            this.hasActiveConversationView(e) ||\n            this.hasOwnedStreamFollowers(e) ||\n            this.shouldKeepConversationLoaded(t)\n          ) {');
}
