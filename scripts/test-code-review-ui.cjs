const assert = require('node:assert/strict');
const path = require('node:path');
const { build } = require('esbuild');
const { chromium } = require('playwright-core');

(async () => {
  const options = { bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', nodePaths: process.env.NODE_PATH?.split(path.delimiter) };
  const host = await build({ ...options, entryPoints: ['src/browser/mcp-app-sandbox.ts'] });
  const fs=require('node:fs');
  const plugin='scratch/asar/plugins/openai-bundled/plugins/code-review/assets/';
  const server=require('fastify')();await require('../src/server/mcp-app-documents.js').registerMcpAppDocuments(server);
  server.get('/host.js',(_req,res)=>res.type('text/javascript').send(host.outputFiles[0].text));
  server.get('/',(_req,res)=>res.type('text/html').send('<html><body><iframe title="fixture"></iframe></body></html>'));
  await server.listen({port:0,host:'127.0.0.1'});
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.goto('http://127.0.0.1:' + server.server.address().port);
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    const appHtml=fs.readFileSync(plugin+'pull-requests.html','utf8');
    const resources=Object.fromEntries([...appHtml.matchAll(/ui:\/\/pull-requests\/app(?:-[a-f0-9]{64})?\.(js|css)/g)].map(([uri,extension])=>[uri,fs.readFileSync(plugin+'pull-requests.'+extension,'utf8')]));
    await page.evaluate(resources=>window.codeReviewResources=resources,resources);
    await page.evaluate(async html => {
      const { connect } = await import('/host.js');
      const controller = new AbortController();
      window.fixtureController = controller;
      window.addEventListener('message', event => { if (event.data?.type === 'navigate-to-route') window.fixtureNavigation = event.data.path; });
      const frame = document.querySelector('iframe');
      window.fixtureApi = connect({ webview: frame, signal: controller.signal, sourceUrl:'https://code-review.example.invalid/', hostApiHandlers: {
        callMcp: async request => {
          window.fixtureRequests??=[];window.fixtureRequests.push(request);
          if(request.method==='resources/read')return {contents:[{uri:request.params.uri,mimeType:request.params.uri.endsWith('js')?'text/javascript':'text/css',text:window.codeReviewResources[request.params.uri]}]};
          window.fixtureRequest = request;
          return {content:[],structuredContent:{cliStatus:{isInstalled:false},currentUser:{status:'error',error:'GitHub CLI (gh) is not installed'}}};
        },
        initializeMcpApp: async () => {}, notifyIntrinsicHeight: () => {}, notifyIntrinsicWidth: () => {},
        notifyEnvironmentError: error => { window.fixtureError = error.message; },
      } });
      window.fixtureRunning = (async () => {
        for await (const status of window.fixtureApi.runWidgetCode({ html, csp: { resourceDomains: ["blob:","data:"], connectDomains: [] }, toolInput: {}, mcpApps: { hostInfo: { name: 'Browser fixture', version: '1.0.0' }, hostCapabilities: { serverTools: {}, serverResources: {}, openLinks: {} }, hostContext: { theme: 'light', displayMode: 'fullscreen', availableDisplayModes: ['fullscreen'] } } })) window.fixtureStatus = status;
      })();
    }, appHtml);
    const frame=page.frameLocator('iframe');
    await frame.getByText('Install GitHub CLI to view and manage your pull requests',{exact:true}).waitFor();
    assert.equal(await frame.getByRole('heading',{name:'Code Review',exact:true}).count(),1);
    assert.equal(await frame.locator('body').evaluate(()=>location.hash),'#/pull-requests');
    assert.equal(await frame.locator('body').evaluate(()=>{try{return parent.document.body.tagName}catch{return 'isolated'}}),'isolated');
    await frame.getByRole('button',{name:'Check again',exact:true}).click();
    await page.waitForFunction(()=>window.fixtureRequests.filter(r=>r.params?.name==='pull_requests.account').length===2);
    assert.deepEqual(errors,[]);
    await page.evaluate(()=>window.fixtureController.abort());
    console.log('Code Review UI: pinned plugin renders its account setup screen, hash route and retry inside the production opaque sandbox');
  } finally { await browser.close(); await server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
