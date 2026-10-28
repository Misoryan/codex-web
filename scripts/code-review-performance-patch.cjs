const ts = require('typescript');

// Patch the pinned upstream plugin; keep its GitHub CLI, SHA guard and merge behavior.
function patchCodeReviewPerformance(source) {
  if (source.includes('const webCliAccounts = new Map();')) return source;
  const tree = ts.createSourceFile('code-review.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const edits = [];
  function replaceFunction(name, change) {
    const nodes = tree.statements.filter(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
    if (nodes.length !== 1) throw Error('Code Review function changed: ' + name);
    const node = nodes[0], before = node.getText(tree), after = change(before);
    if (after === before) throw Error('Code Review performance anchor changed: ' + name);
    edits.push([node.getStart(tree), node.end, after]);
  }
  replaceFunction('getCurrentUser', before => before.replace(
    'let usesService2 = githubProviderRequired();',
    'let usesService2 = githubProviderRequired();\n  if (!usesService2) return webCliCurrentUser(hostname3, fresh);'
  ));
  replaceFunction('getAccount', before => before.replace(
    'let cliStatus = await githubCliStatus(host2, void 0, hostname3);',
    'const [cliStatus, currentUser] = await Promise.all([githubCliStatus(host2, void 0, hostname3), getCurrentUser(hostname3, true)]);'
  ).replace('let currentUser = await getCurrentUser(hostname3);',''));
  replaceFunction('observeCurrentUser', before => before.replace(
    'checkGitHubWork();',
    'checkGitHubWork();\n  if (current.status !== "success") webCliAccounts.delete(hostname3);'
  ));
  replaceFunction('registerTool', before => before.replace(
    'if (kind === "access") {',
    'if (kind === "access") {\n              webCliAccounts.delete(hostname3.toLowerCase());'
  ));
  replaceFunction('githubPrMerge', before => before.replace(
    /\(await assertGhInstalledAndAuthed\([\s\S]*?\), await mergePullRequestWithGh\(/,
    '(await mergePullRequestWithGh('
  ));
  for (const [start, end, value] of edits.sort((a,b) => b[0]-a[0])) source = source.slice(0,start)+value+source.slice(end);
  // Cache identities only. PR state/checks/merge results retain upstream freshness.
  const main = '// server/main.ts';
  if (source.split(main).length !== 2) throw Error('Code Review startup changed');
  return source.replace(main, `
const webCliAccounts = new Map();
async function webCliCurrentUser(hostname, fresh) {
  await requireConfiguredGitHubHost(hostname);
  const scope = host2.githubRequests.getStore();
  const accounts = scope ? (scope.webAccounts ??= new Map()) : null;
  if (accounts?.has(hostname)) return accounts.get(hostname);
  let entry = webCliAccounts.get(hostname);
  if (fresh || !entry || entry.expiresAt <= Date.now()) {
    entry = {expiresAt: Infinity};
    entry.request = githubCurrentUser(host2, hostname).then(current => observeCurrentUser(hostname, current)).then(current => {
      entry.expiresAt = current.status === "success" ? Date.now() + 30000 : 0;
      return current;
    }, error => { entry.expiresAt = 0; throw error; });
    webCliAccounts.set(hostname, entry);
  }
  accounts?.set(hostname, entry.request);
  return entry.request;
}
` + main);
}
// Start conflict detection alongside the summary. The results are joined only
// when both head and base match; metadata must also confirm write permission.
function patchCodeReviewMergeReadiness(source) {
  const replacements = [
    ['let n=Jme(e.request),i=t(gIe,e).data,a=Math.max(', 'let n=Jme(e.request),a=Math.max('],
    ['enabled:e.provider==="github-cli"&&i?.status==="success"&&i.hasOpenPr,queryFn:', 'enabled:e.provider==="github-cli",queryFn:'],
    ['canMerge:i.error==null&&i.data?.status==="success"&&i.data.canMerge,mergeBlocker:', 'canMerge:h&&s?.hasWritePermission===!0&&i.error==null&&i.data?.status==="success"&&i.data.canMerge,mergeBlocker:'],
  ];
  for (const [before, after] of replacements) {
    if (source.includes(after) && !source.includes(before)) continue;
    if (source.split(before).length !== 2) throw Error('Code Review merge readiness anchor changed: ' + before);
    source = source.replace(before, after);
  }
  return source;
}

function patchCodeReviewSequentialMerges(source) {
  if (source.includes('function webInvalidateRepositoryMergeReadiness(')) return source;
  const tree = ts.createSourceFile('pull-requests.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const edits = [];
  for (const [name, before, after] of [
    // The header depends on summary, permissions and mergeability. Description
    // and discussion have their own loading states and must not hide it.
    ['wIl', 'o.isPending||!i&&o.data!=null&&w.content', 'o.isPending'],
    // Give the three readiness reads the available GitHub request capacity.
    // Content starts once they settle, including errors and blocked PRs.
    ['Vut', 'return{meta:{hostId:o.account.hostId}', 'return{enabled:n.provider!=="github-cli"||e==="gh-pr-metadata"||!i(gIe,n).isPending&&!i(gfi,n).isPending&&!i(Ofi,n).isPending,meta:{hostId:o.account.hostId}'],
    // GitHub has accepted the merge. Finish the confirmation immediately while
    // the merged PR and inbox refresh in the background.
    ['uks', '{onSuccess:()=>{d1i(a,e,{action:"merge"}),i()}}', '{awaitRefresh:!1,onSuccess:()=>{d1i(a,e,{action:"merge"}),webInvalidateRepositoryMergeReadiness(a,e),i()}}'],
  ]) {
    const nodes = tree.statements.filter(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
    if (nodes.length !== 1) throw Error('Code Review sequential merge function changed: ' + name);
    const node = nodes[0], text = node.getText(tree);
    if (text.split(before).length !== 2) throw Error('Code Review sequential merge anchor changed: ' + name);
    edits.push([node.getStart(tree), node.end, text.replace(before, after)]);
  }
  for (const [start, end, value] of edits.sort((a,b) => b[0]-a[0])) source = source.slice(0,start)+value+source.slice(end);
  return source + `
// A merge changes the base of sibling PRs. Keep their content, but require
// fresh summary and conflict checks before another manual merge is offered.
function webInvalidateRepositoryMergeReadiness(client, request) {
  const target = Jme(request);
  for (const query of client.getQueryCache().findAll({queryKey:[con]})) {
    if (!['gh-pr-summary','gh-pr-mergeability'].includes(query.queryKey[1])) continue;
    const other = JSON.parse(query.queryKey[2]);
    if (JSON.stringify(other.account) !== JSON.stringify(target.account) ||
        other.pullRequest.hostname !== target.pullRequest.hostname ||
        other.pullRequest.owner !== target.pullRequest.owner ||
        other.pullRequest.repository !== target.pullRequest.repository ||
        other.pullRequest.number === target.pullRequest.number) continue;
    client.setQueryData(query.queryKey, data => data?.status === 'success' ? {...data,canMerge:false,mergeBlocker:'unknown'} : data);
    void client.invalidateQueries({queryKey:query.queryKey,exact:true,refetchType:'none'});
  }
}
`;
}
module.exports = {patchCodeReviewPerformance,patchCodeReviewMergeReadiness,patchCodeReviewSequentialMerges};
