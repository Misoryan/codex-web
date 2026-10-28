const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {build}=require('esbuild'),{chromium,expect}=require('@playwright/test');
const {patchCodeReviewMergeReadiness,patchCodeReviewSequentialMerges}=require('./code-review-performance-patch.cjs');

// Real Code Review UI and sandbox. MCP responses represent external GitHub
// facts; production UI owns navigation, query freshness and mutation completion.
(async()=>{
  const host=await build({entryPoints:['src/browser/mcp-app-sandbox.ts'],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',nodePaths:process.env.NODE_PATH?.split(path.delimiter)});
  const directory='scratch/asar/plugins/openai-bundled/plugins/code-review/assets/';
  const ui=patchCodeReviewSequentialMerges(patchCodeReviewMergeReadiness(fs.readFileSync(directory+'pull-requests.js','utf8')));
  assert.equal(patchCodeReviewSequentialMerges(ui),ui);
  let html=fs.readFileSync(directory+'pull-requests.html','utf8');const resources={};
  for(const extension of ['js','css']){
    const content=extension==='js'?ui:fs.readFileSync(directory+'pull-requests.css','utf8');
    const uri='ui://pull-requests/app-'+crypto.createHash('sha256').update(content).digest('hex')+'.'+extension;
    html=html.replace(new RegExp('ui://pull-requests/app(?:-[a-f0-9]{64})?\\.'+extension,'g'),uri);resources[uri]=content;
  }
  const server=require('fastify')();await require('../src/server/mcp-app-documents.js').registerMcpAppDocuments(server);
  server.get('/host.js',(_req,res)=>res.type('text/javascript').send(host.outputFiles[0].text));
  server.get('/',(_req,res)=>res.type('text/html').send('<html><body><iframe style="width:1200px;height:900px"></iframe></body></html>'));
  await server.listen({port:0,host:'127.0.0.1'});const browser=await chromium.launch({channel:'chrome',headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1280,height:1000}});page.setDefaultTimeout(10000);
    page.on('pageerror',error=>console.error('UI error:',error.message));
    await page.goto('http://127.0.0.1:'+server.server.address().port);
    await page.evaluate(({resources,html})=>{
      const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve}};
      const slowContent=deferred(),refresh=deferred(),nextRead=deferred();
      window.fixture={calls:[],merges:[],merged:[],base:0,holdNext:false,failNext:false};
      window.releaseNext=()=>nextRead.resolve();window.releaseRefresh=()=>refresh.resolve();
      const account={hostId:'local',hostname:'github.com',login:'fixtureuser'};
      const controller=new AbortController();window.fixtureController=controller;
      window.fixtureRunning=(async()=>{
        const {connect}=await import('/host.js');
        const api=connect({webview:document.querySelector('iframe'),signal:controller.signal,sourceUrl:'https://code-review.example.invalid/',hostApiHandlers:{
          callMcp:async request=>{
            if(request.method==='resources/read')return{contents:[{uri:request.params.uri,mimeType:request.params.uri.endsWith('js')?'text/javascript':'text/css',text:resources[request.params.uri]}]};
            const name=request.params.name,args=request.params.arguments,number=args?.pullRequest?.number;
            const entry={name,number,start:performance.now()};fixture.calls.push(entry);let value;
            if(name==='pull_requests.account')value={cliStatus:{isInstalled:true,isAuthenticated:true},currentUser:{status:'success',account,login:'fixtureuser'}};
            else if(name==='pull_requests.search')value={items:[],totalCount:0,endCursor:null,hasNextPage:false,truncated:false};
            else if(name==='pull_requests.merge'){
              fixture.merges.push(args);
              if(fixture.failNext){fixture.failNext=false;value={status:'error',error:'head revision changed'}}
              else{fixture.merged.push(number);fixture.base++;value={status:'success'}}
            }else if(name==='pull_requests.body'||name==='pull_requests.discussion'){
              await slowContent.promise;
            }else{
              if(fixture.merged.includes(number))await refresh.promise;
              if(fixture.holdNext&&number===43&&['pull_requests.summary','pull_requests.mergeability'].includes(name))await nextRead.promise;
              switch(name){
                case 'pull_requests.summary':value={status:'success',baseBranch:'main',baseRevision:'base-'+fixture.base,headBranch:'feature-'+number,headRevision:'head-'+number,checks:[],checksComplete:true,ciStatus:'none',hasOpenPr:!fixture.merged.includes(number),hasPendingChecks:false,isDraft:false,isInMergeQueue:false,state:fixture.merged.includes(number)?'merged':'open',title:'Sequential PR '+number,url:'https://github.com/fixture/repo/pull/'+number};break;
                case 'pull_requests.metadata':value={status:'success',headRevision:'head-'+number,hasWritePermission:true,viewerCanUpdate:true,canManageReviewers:true,additions:1,deletions:0,changedFiles:1,authorLogin:'fixtureuser',createdAt:'2026-01-01T00:00:00Z',isAuthor:true,isAutoMergeEnabled:false,allowedMergeMethods:['squash','merge']};break;
                case 'pull_requests.mergeability':value={status:'success',headRevision:'head-'+number,baseRevision:'base-'+fixture.base,canMerge:!fixture.merged.includes(number),mergeBlocker:null};break;
                case 'pull_requests.reviews':value={status:'success',reviewers:{approved:[],avatarUrlsByLogin:{},commentCounts:[],commented:[],changesRequested:[],requested:[],requestedTeamSlugs:{},requestedTeams:[]},reviewStatus:'none',isPartial:false};break;
                case 'pull_requests.localReview':value={review:null};break;
                default:value={status:'unavailable'};
              }
            }
            entry.end=performance.now();return{content:[],structuredContent:value};
          },initializeMcpApp:async()=>{},notifyIntrinsicHeight:()=>{},notifyIntrinsicWidth:()=>{},notifyEnvironmentError:error=>{window.fixtureError=error.message},
        }});
        for await(const status of api.runWidgetCode({html,csp:{resourceDomains:['blob:','data:'],connectDomains:[]},toolInput:{},mcpApps:{hostInfo:{name:'Sequential fixture',version:'1'},hostCapabilities:{serverTools:{},serverResources:{},openLinks:{}},hostContext:{theme:'light',displayMode:'fullscreen',availableDisplayModes:['fullscreen']}}}))window.fixtureStatus=status;
      })();
    },{resources,html});
    const frame=page.frameLocator('iframe');await frame.getByText('Select a pull request',{exact:true}).waitFor();
    const navigate=number=>frame.locator('body').evaluate((_node,n)=>{location.hash='#/pull-requests/github.com/fixture/repo/'+n},number);
    const action=frame.getByRole('menuitem',{name:'Merge',exact:true});
    async function openMerge(){const button=frame.getByRole('button',{name:'Merge',exact:true});await expect(button).toBeEnabled();await button.click();await expect(action).toBeEnabled();await action.click();await frame.getByRole('button',{name:'Squash',exact:true}).click()}
    async function submitMerge(number){
      await openMerge();
      await frame.getByRole('button',{name:'Squash and merge',exact:true}).click();
      await page.waitForFunction(n=>fixture.merges.some(m=>m.pullRequest.number===n),number);
    }
    await navigate(42);await frame.getByText('Sequential PR 42',{exact:true}).first().waitFor().catch(async error=>{console.log(await frame.locator('body').innerText(),await page.evaluate(()=>fixture));throw error});
    // Both requests remain unresolved for the entire test. Waiting for either
    // would leave the header hidden and fail before a merge can be submitted.
    await page.waitForFunction(()=>['body','discussion'].every(n=>fixture.calls.some(c=>c.name==='pull_requests.'+n&&c.end==null)));
    await navigate(43);await expect(frame.getByText('Sequential PR 43',{exact:true}).first()).toBeVisible();
    await expect(frame.getByRole('button',{name:'Merge',exact:true})).toBeEnabled();
    await navigate(42);await page.evaluate(()=>{fixture.holdNext=true});
    await submitMerge(42);
    // Accepted merge closes its confirmation even though its follow-up reads
    // and the inbox refresh have not completed.
    await expect(frame.getByRole('button',{name:'Squash and merge',exact:true})).toHaveCount(0);
    await page.waitForFunction(()=>fixture.calls.some(c=>c.number===42&&c.start>fixture.calls.find(c=>c.name==='pull_requests.merge').start&&c.end==null));
    await navigate(43);
    await page.waitForFunction(()=>fixture.calls.filter(c=>c.number===43&&c.name==='pull_requests.mergeability').length===2);
    await frame.locator('body').evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
    const outer=frame.getByRole('button',{name:'Merge',exact:true});
    if(await outer.count()&&await outer.isEnabled()){
      await outer.click();await expect(action).toBeDisabled();await frame.locator('body').press('Escape');
    }
    await page.evaluate(()=>releaseNext());await submitMerge(43);
    await expect(frame.getByRole('button',{name:'Squash and merge',exact:true})).toHaveCount(0);
    await navigate(44);await page.evaluate(()=>{fixture.failNext=true});
    await submitMerge(44);await expect(frame.getByRole('alert')).toContainText('head revision changed');
    // A failed merge keeps confirmation open and permits a fresh retry.
    assert.deepEqual(await page.evaluate(()=>fixture.merged),[42,43]);
    await frame.getByRole('button',{name:'Squash and merge',exact:true}).click();
    await expect(frame.getByRole('button',{name:'Squash and merge',exact:true})).toHaveCount(0);
    assert.deepEqual(await page.evaluate(()=>fixture.merged),[42,43,44]);
    const writes=await page.evaluate(()=>fixture.merges);
    assert.deepEqual(writes.map(m=>[m.pullRequest.number,m.expectedHeadRevision,m.mergeMethod]),[[42,'head-42','squash'],[43,'head-43','squash'],[44,'head-44','squash'],[44,'head-44','squash']]);
    await page.evaluate(()=>fixtureController.abort());
    console.log('Sequential Code Review UI: 3 accepted merges, slow content/refresh, fresh sibling base and rejected merge retry passed. No real GitHub writes.');
  }finally{await browser.close();await server.close()}
})().catch(error=>{console.error(error);process.exitCode=1});
