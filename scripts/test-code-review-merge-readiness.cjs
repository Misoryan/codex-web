const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {build}=require('esbuild'),{chromium}=require('playwright-core');
const {patchCodeReviewMergeReadiness,patchCodeReviewSequentialMerges}=require('./code-review-performance-patch.cjs');

// The real plugin UI and production sandbox consume controlled external MCP
// responses. No query, permission or revision decision is implemented here.
(async()=>{
  const host=await build({entryPoints:['src/browser/mcp-app-sandbox.ts'],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',nodePaths:process.env.NODE_PATH?.split(path.delimiter)});
  const directory='scratch/asar/plugins/openai-bundled/plugins/code-review/assets/';
  const ui=patchCodeReviewSequentialMerges(patchCodeReviewMergeReadiness(fs.readFileSync(directory+'pull-requests.js','utf8')));
  assert.equal(patchCodeReviewMergeReadiness(ui),ui);
  let appHtml=fs.readFileSync(directory+'pull-requests.html','utf8');const resources={};
  for(const extension of ['js','css']){
    const text=extension==='js'?ui:fs.readFileSync(directory+'pull-requests.css','utf8');
    const uri='ui://pull-requests/app-'+crypto.createHash('sha256').update(text).digest('hex')+'.'+extension;
    appHtml=appHtml.replace(new RegExp('ui://pull-requests/app(?:-[a-f0-9]{64})?\\.'+extension,'g'),uri);resources[uri]=text;
  }
  const server=require('fastify')();await require('../src/server/mcp-app-documents.js').registerMcpAppDocuments(server);
  server.get('/host.js',(_req,res)=>res.type('text/javascript').send(host.outputFiles[0].text));
  server.get('/',(_req,res)=>res.type('text/html').send('<html><body><iframe></iframe></body></html>'));
  await server.listen({port:0,host:'127.0.0.1'});
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try{
    for(const scenario of ['ready','metadata-pending','no-write','metadata-head','merge-head','merge-base','conflict','draft','merge-error']){
      const page=await browser.newPage();await page.goto('http://127.0.0.1:'+server.server.address().port);
      await page.evaluate(({resources,html,scenario})=>{
        window.fixtureResources=resources;window.fixtureCalls=[];window.fixtureDelivered=[];window.fixtureWrites=[];
        const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve}};
        const summary=deferred(),metadata=deferred(),mergeability=deferred();
        const account={hostId:'local',hostname:'github.com',login:'fixtureuser'};
        const pullRequest={hostname:'github.com',owner:'fixture',repository:'repo',number:42};
        window.fixtureRelease=()=>{
          summary.resolve({status:'success',baseBranch:'main',baseRevision:'base-123',headBranch:'feature',headRevision:'head-123',checks:[],checksComplete:true,ciStatus:'none',hasOpenPr:true,hasPendingChecks:false,isDraft:scenario==='draft',isInMergeQueue:false,state:'open',title:'Merge readiness fixture',url:'https://github.com/fixture/repo/pull/42'});
          mergeability.resolve(scenario==='merge-error'?{status:'unavailable'}:{status:'success',headRevision:scenario==='merge-head'?'head-new':'head-123',baseRevision:scenario==='merge-base'?'base-new':'base-123',canMerge:scenario!=='conflict',mergeBlocker:scenario==='conflict'?'conflicts':null});
          if(scenario!=='metadata-pending')metadata.resolve({status:'success',headRevision:scenario==='metadata-head'?'head-new':'head-123',hasWritePermission:scenario!=='no-write',viewerCanUpdate:true,canManageReviewers:true,additions:1,deletions:0,changedFiles:1,authorLogin:'fixtureuser',createdAt:'2026-01-01T00:00:00Z',isAuthor:true,isAutoMergeEnabled:false,allowedMergeMethods:['squash','merge']});
        };
        const controller=new AbortController();window.fixtureController=controller;
        window.fixtureRunning=(async()=>{
          const {connect}=await import('/host.js');
          const api=connect({webview:document.querySelector('iframe'),signal:controller.signal,sourceUrl:'https://code-review.example.invalid/',hostApiHandlers:{
            callMcp:async request=>{
              if(request.method==='resources/read')return{contents:[{uri:request.params.uri,mimeType:request.params.uri.endsWith('js')?'text/javascript':'text/css',text:resources[request.params.uri]}]};
              const name=request.params?.name;window.fixtureCalls.push(name);
              let value;
              switch(name){
                case 'pull_requests.account':value={cliStatus:{isInstalled:true,isAuthenticated:true},currentUser:{status:'success',account,login:'fixtureuser'}};break;
                case 'pull_requests.search':value={items:[],totalCount:0,endCursor:null,hasNextPage:false,truncated:false};break;
                case 'pull_requests.summary':value=await summary.promise;break;
                case 'pull_requests.metadata':value=await metadata.promise;break;
                case 'pull_requests.mergeability':value=await mergeability.promise;break;
                case 'pull_requests.body':value={status:'success',body:'An isolated pull request.'};break;
                case 'pull_requests.reviews':value={status:'success',reviewers:{approved:[],avatarUrlsByLogin:{},commentCounts:[],commented:[],changesRequested:[],requested:[],requestedTeamSlugs:{},requestedTeams:[]},reviewStatus:'none',isPartial:false};break;
                case 'pull_requests.discussion':value={status:'success',activityItems:[],commentAttachments:[],supportsPendingReview:true,pendingReview:null,isPartial:false,unresolvedCommentCount:0};break;
                case 'pull_requests.localReview':value={review:null};break;
                default:
                  if(/merge$|comment|submitReview|update/.test(name??''))window.fixtureWrites.push(name);
                  value={status:'unavailable'};
              }
              window.fixtureDelivered.push(name);return{content:[],structuredContent:value};
            },initializeMcpApp:async()=>{},notifyIntrinsicHeight:()=>{},notifyIntrinsicWidth:()=>{},notifyEnvironmentError:error=>{window.fixtureError=error.message},
          }});
          for await(const status of api.runWidgetCode({html,csp:{resourceDomains:['blob:','data:'],connectDomains:[]},toolInput:{},mcpApps:{hostInfo:{name:'Browser fixture',version:'1'},hostCapabilities:{serverTools:{},serverResources:{},openLinks:{}},hostContext:{theme:'light',displayMode:'fullscreen',availableDisplayModes:['fullscreen']}}}))window.fixtureStatus=status;
        })();
      },{resources,html:appHtml,scenario});
      const frame=page.frameLocator('iframe');
      await frame.getByText('Select a pull request',{exact:true}).waitFor();
      await frame.locator('body').evaluate(()=>location.hash='#/pull-requests/github.com/fixture/repo/42');
      // A serial implementation never asks for mergeability while summary is held.
      await page.waitForFunction(()=>['summary','metadata','mergeability'].every(n=>fixtureCalls.includes('pull_requests.'+n)),{},{timeout:8000});
      assert.equal(await page.evaluate(()=>['body','reviews','discussion'].some(n=>fixtureCalls.includes('pull_requests.'+n))),false,'Content waits for readiness reads to settle');
      assert.equal(await frame.getByRole('button',{name:'Merge',exact:true}).count(),0,'Unresolved summary cannot enable merging');
      await page.evaluate(()=>fixtureRelease());
      if(scenario==='metadata-pending'){
        await page.waitForFunction(()=>fixtureDelivered.includes('pull_requests.summary')&&fixtureDelivered.includes('pull_requests.mergeability'));
        await frame.locator('body').evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
        const pending=frame.getByRole('button',{name:'Merge',exact:true});
        assert.equal(await pending.count()>0?await pending.isEnabled():false,false,'Pending permission cannot enable merging');
        await page.evaluate(()=>fixtureController.abort());await page.close();console.log('Merge readiness UI: '+scenario);continue;
      }
      await frame.getByText('Merge readiness fixture',{exact:true}).first().waitFor();
      await page.waitForFunction(()=>['summary','metadata','mergeability'].every(n=>fixtureDelivered.includes('pull_requests.'+n)));
      await frame.locator('body').evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      const button=frame.getByRole('button',{name:'Merge',exact:true,includeHidden:true});
      if(scenario==='ready'){
        await button.click();const action=frame.getByRole('menuitem',{name:'Merge',exact:true});
        await action.waitFor();assert.equal(await action.isEnabled(),true);await action.click({trial:true});
      }else{
        // Auto-merge may expose the outer dropdown while manual Merge is disabled.
        if(await button.count()===0){assert(['draft','no-write','merge-error'].includes(scenario),'Unexpected missing Merge: '+scenario)}
        else if(await button.isEnabled()){
          await button.click();const action=frame.getByRole('menuitem',{name:'Merge',exact:true});await action.waitFor();
          assert.equal(await action.isDisabled(),true,scenario+' must block actual merging');
        }else assert.equal(await button.isDisabled(),true);
      }
      assert.deepEqual(await page.evaluate(()=>fixtureWrites),[],'Tests never submit a mutation');
      await page.evaluate(()=>fixtureController.abort());await page.close();console.log('Merge readiness UI: '+scenario);
    }
  }finally{await browser.close();await server.close()}
})().catch(error=>{console.error(error);process.exitCode=1});
