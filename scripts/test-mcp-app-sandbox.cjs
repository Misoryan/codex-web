const assert = require('node:assert/strict');
const Fastify = require('fastify');
const {registerMcpAppDocuments}=require('../src/server/mcp-app-documents.js');
const path = require('node:path');
const { build } = require('esbuild');
const { chromium } = require('playwright-core');

(async () => {
  const options = { bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', nodePaths: process.env.NODE_PATH?.split(path.delimiter) };
  const host = await build({ ...options, entryPoints: ['src/browser/mcp-app-sandbox.ts'] });
  const app = await build({ ...options, stdin: { resolveDir: process.cwd(), contents: `
    import { App } from '@modelcontextprotocol/ext-apps';
    import { z } from 'zod';
    history.replaceState(null,'','#/pull-requests');
    const stored=localStorage.getItem('pane-width');
    localStorage.setItem('pane-width','420');
    const app = new App({name:'fixture',version:'1.0.0'},{});
    app.setNotificationHandler(z.object({method:z.literal('ui/notifications/openai/first-party-plugin-bridge'),params:z.object({message:z.string()})}),({params})=>document.body.dataset.bridgeMessage=params.message);
    app.addEventListener('hostcontextchanged', c => document.body.dataset.theme=c.theme);
    await app.connect();
    const result = await app.callServerTool({name:'read_fixture',arguments:{id:42}});
    document.querySelector('#result').textContent=result.content[0].text;
    document.querySelector('#preferences').textContent=stored??'unset';
    document.body.dataset.hostSecret=localStorage.getItem('host-secret')??'isolated';
    document.querySelector('button').onclick=()=>app.openLink({url:'codex://threads/00000000-0000-4000-8000-000000000042'});
    document.querySelector('#bridge').onclick=async()=>{
      await app.request({method:'ui/openai/first-party-plugin-bridge',params:{message:'fixture-sidebar-subscribe'}},z.object({}));
      document.body.dataset.bridgeAcknowledged='true';
    };
    document.querySelector('#create').onsubmit=async event=>{
      event.preventDefault();
      await app.callServerTool({name:'create_fixture',arguments:{title:document.querySelector('input').value}});
      document.querySelector('#submitted').textContent=String(++window.submissions);
    };
    window.submissions=0;
    document.addEventListener('securitypolicyviolation',event=>{if(event.violatedDirective==='form-action')document.body.dataset.formBlocked='true'});
  ` } });
  const server = Fastify();
  await registerMcpAppDocuments(server);
  server.get('/host.js',(_req,res)=>res.type('text/javascript').send(host.outputFiles[0].text));
  server.get('/',(_req,res)=>res.type('text/html').send('<html><body><iframe title="fixture"></iframe></body></html>'));
  await server.listen({port:0,host:'127.0.0.1'});
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.goto('http://127.0.0.1:' + server.server.address().port);
    assert.equal((await server.inject({method:'POST',url:'/__backend/mcp-app-documents',headers:{origin:'https://foreign.example.invalid','sec-fetch-site':'cross-site'},payload:{html:'foreign'}})).statusCode,403);
    assert.equal((await server.inject({method:'POST',url:'/__backend/mcp-app-documents',headers:{origin:'null'},payload:{html:'foreign'}})).statusCode,403);
    const appHtml = '<main id="result">Loading</main><output id="preferences"></output><button>Open conversation</button><button id="bridge">Subscribe sidebar</button><form id="create"><input required name="title"><button type="submit">Create fixture</button></form><output id="submitted"></output><form id="native" action="https://blocked-form.example.invalid/submit"><button>Native form</button></form><script type="module">' + app.outputFiles[0].text.replaceAll('</script', '<\\/script') + '</script>';
    await page.evaluate(async html => {
      const { connect } = await import('/host.js');
      const controller = new AbortController();
      window.fixtureController = controller;
      window.addEventListener('message', event => { if (event.data?.type === 'navigate-to-route') window.fixtureNavigation = event.data.path; });
      const frame = document.querySelector('iframe');
      localStorage.setItem('host-secret','private-host-value');
      window.fixtureHandlers = {
        callMcp: async request => {
          window.fixtureRequest = request;
          if(request.method==='ui/openai/first-party-plugin-bridge'){
            await window.fixtureApi.notifyMcpAppsMcpNotification({method:'ui/notifications/openai/first-party-plugin-bridge',params:{message:'fixture-sidebar-snapshot'}});
            return {};
          }
          return { content: [{ type: 'text', text: 'Fixture item 42' }] };
        },
        initializeMcpApp: async () => {}, notifyIntrinsicHeight: () => {}, notifyIntrinsicWidth: () => {},
        notifyEnvironmentError: error => { window.fixtureError = error.message; },
      };
      window.fixtureConnect = connect;
      window.fixtureHtml = html;
      window.fixtureApi = connect({ webview: frame, signal: controller.signal, sourceUrl: 'https://fixture-app.example.invalid/', hostApiHandlers: window.fixtureHandlers });
      window.fixtureRunning = (async () => {
        for await (const status of window.fixtureApi.runWidgetCode({ html, csp: { resourceDomains: [], connectDomains: [] }, toolInput: {}, mcpApps: { hostInfo: { name: 'Browser fixture', version: '1.0.0' }, hostCapabilities: { serverTools: {}, openLinks: {} }, hostContext: { theme: 'light', displayMode: 'fullscreen', availableDisplayModes: ['fullscreen'] } } })) window.fixtureStatus = status;
      })();
    }, appHtml);
    const frame = page.frameLocator('iframe');
    await frame.locator('#result').filter({ hasText: 'Fixture item 42' }).waitFor();
    await page.waitForFunction(() => window.fixtureStatus?.status === 2);
    const request = await page.evaluate(() => window.fixtureRequest);
    assert.equal(request.method, 'tools/call');
    assert.equal(request.params.name, 'read_fixture');
    assert.deepEqual(request.params.arguments, { id: 42 });
    await frame.getByRole('button',{name:'Subscribe sidebar'}).click();
    await frame.locator('body[data-bridge-acknowledged="true"][data-bridge-message="fixture-sidebar-snapshot"]').waitFor();
    assert.deepEqual(await page.evaluate(()=>window.fixtureRequest),{method:'ui/openai/first-party-plugin-bridge',params:{message:'fixture-sidebar-subscribe'}});
    assert.equal(await page.locator('iframe').getAttribute('sandbox'), 'allow-scripts allow-forms');
    assert.equal(await frame.locator('body').evaluate(() => { try { return window.parent.document.body.tagName; } catch { return 'isolated'; } }), 'isolated');
    assert.equal(await frame.locator('body').getAttribute('data-host-secret'), 'isolated');
    assert.equal(await frame.locator('#preferences').textContent(), 'unset');
    assert.equal(await frame.locator('body').evaluate(() => location.hash), '#/pull-requests');
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('codex:web-mcp-app:https://fixture-app.example.invalid/')??'{}')['pane-width']==='420');
    await page.evaluate(() => window.fixtureApi.setTheme({ theme: 'dark' }));
    await frame.locator('body[data-theme="dark"]').waitFor();
    await frame.getByRole('button', { name: 'Open conversation' }).click();
    await page.waitForFunction(() => window.fixtureNavigation === '/local/00000000-0000-4000-8000-000000000042');
    await frame.getByRole('button', { name: 'Create fixture' }).click();
    assert.equal(await frame.locator('#submitted').textContent(), '');
    await frame.locator('input').fill('Fixture work');
    await frame.getByRole('button', { name: 'Create fixture' }).click();
    await frame.locator('#submitted').filter({hasText:'1'}).waitFor();
    const submitted = await page.evaluate(()=>window.fixtureRequest);
    assert.equal(submitted.method, 'tools/call');
    assert.equal(submitted.params.name, 'create_fixture');
    assert.deepEqual(submitted.params.arguments, {title:'Fixture work'});
    await frame.locator('input').press('Enter');
    await frame.locator('#submitted').filter({hasText:'2'}).waitFor();
    await frame.getByRole('button', { name: 'Native form' }).click();
    await frame.locator('body[data-form-blocked="true"]').waitFor();
    await frame.locator('#result').filter({hasText:'Fixture item 42'}).waitFor();
    const documentUrl=await page.locator('iframe').getAttribute('src');
    const headers=await server.inject({url:documentUrl});
    assert.equal(headers.headers['content-security-policy'],"sandbox allow-scripts allow-forms; frame-ancestors 'self'");
    assert.equal(headers.headers['cache-control'],'no-store');
    await page.evaluate(() => window.fixtureController.abort());
    assert.equal(await page.locator('iframe').getAttribute('src'), null);
    await page.waitForFunction(url=>fetch(url).then(r=>r.status===404),documentUrl);
    for(const [sourceUrl,expected] of [['https://fixture-app.example.invalid/','420'],['https://other-app.example.invalid/','unset']]) {
      await page.evaluate(sourceUrl=>{
        window.fixtureController=new AbortController();
        window.fixtureApi=window.fixtureConnect({webview:document.querySelector('iframe'),signal:window.fixtureController.signal,sourceUrl,hostApiHandlers:window.fixtureHandlers});
        window.fixtureRunning=(async()=>{for await(const status of window.fixtureApi.runWidgetCode({html:window.fixtureHtml,csp:{resourceDomains:[],connectDomains:[]},mcpApps:{hostInfo:{name:'Fixture',version:'1.0.0'},hostCapabilities:{serverTools:{},openLinks:{}},hostContext:{theme:'light',displayMode:'fullscreen',availableDisplayModes:['fullscreen']}}}))window.fixtureStatus=status;})();
      },sourceUrl);
      await frame.locator('#preferences').filter({hasText:expected}).waitFor();
      assert.equal(await frame.locator('body').getAttribute('data-host-secret'), 'isolated');
      await page.evaluate(()=>window.fixtureController.abort());
    }
    console.log('MCP app browser boundary: hash routing, isolated persistent preferences, SDK tool calls, click/Enter submission, blocked form navigation, opaque isolation, host theme, conversation navigation and teardown passed');
  } finally { await browser.close(); await server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
