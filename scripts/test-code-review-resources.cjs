const assert=require('node:assert/strict'),path=require('node:path'),{createHash}=require('node:crypto');
const {build}=require('esbuild'),{chromium}=require('playwright-core');

(async()=>{
  const options={bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',nodePaths:process.env.NODE_PATH?.split(path.delimiter)};
  const host=await build({...options,entryPoints:['src/browser/mcp-app-sandbox.ts']});
  const app=await build({...options,stdin:{resolveDir:process.cwd(),contents:`
    import { App } from '@modelcontextprotocol/ext-apps';
    const app=new App({name:'resource-fixture',version:'1'},{});await app.connect();
    app.ontoolinput=async ({arguments:args})=>{
      try{
        const resource=await app.readServerResource({uri:args.uri});
        const privateResult=await app.callServerTool({name:'read_pr',arguments:{}});
        document.querySelector('output').textContent=JSON.stringify({asset:resource.contents[0].text,pr:privateResult.structuredContent.pr});
      }catch(error){document.querySelector('output').textContent=error.message}
    };
  `}});
  const server=require('fastify')();await require('../src/server/mcp-app-documents.js').registerMcpAppDocuments(server);
  server.get('/host.js',(_req,res)=>res.type('text/javascript').send(host.outputFiles[0].text));
  server.get('/',(_req,res)=>res.type('text/html').send('<html><body><iframe></iframe></body></html>'));
  await server.listen({port:0,host:'127.0.0.1'});
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try{
    const page=await browser.newPage();await page.goto('http://127.0.0.1:'+server.server.address().port);
    const html='<output></output><script type="module">'+app.outputFiles[0].text.replaceAll('</script','<\\/script')+'</script>';
    const uri=text=>'ui://pull-requests/app-'+createHash('sha256').update(text).digest('hex')+'.js';
    let calls=0,privateCalls=0;
    for(const [sourceUrl,address,bytes,expectedReads,expectedError] of [
      ['https://plugin.example.invalid/',uri('v1'),'v1',1,null],
      ['https://plugin.example.invalid/',uri('v1'),'v1',0,null],
      ['https://plugin.example.invalid/',uri('v2'),'v2',1,null],
      ['https://other-plugin.example.invalid/',uri('v2'),'v2',1,null],
      ['https://plugin.example.invalid/',uri('v3'),'wrong bytes',1,'hash differs'],
      ['https://plugin.example.invalid/',uri('v3'),'v3',1,null],
      ['https://plugin.example.invalid/','ui://pull-requests/body','private-first',1,null],
      ['https://plugin.example.invalid/','ui://pull-requests/body','private-second',1,null],
    ]){
      await page.evaluate(async({sourceUrl,address,bytes,html})=>{
        window.resourceCalls=0;window.privateCalls=0;
        const {connect}=await import('/host.js');
        const controller=new AbortController();window.controller=controller;
        const api=connect({webview:document.querySelector('iframe'),signal:controller.signal,sourceUrl,hostApiHandlers:{
          callMcp:async request=>{
            if(request.method==='resources/read'){window.resourceCalls++;return{contents:[{uri:request.params.uri,mimeType:'text/javascript',text:bytes}]}}
            window.privateCalls++;return{content:[],structuredContent:{pr:'fresh PR data'}};
          },initializeMcpApp:async()=>{},notifyIntrinsicHeight:()=>{},notifyIntrinsicWidth:()=>{},notifyEnvironmentError:error=>{window.fixtureError=error.message},
        }});
        window.running=(async()=>{for await(const status of api.runWidgetCode({html,toolInput:{uri:address},csp:{resourceDomains:[],connectDomains:[]},mcpApps:{hostInfo:{name:'Host',version:'1'},hostCapabilities:{serverTools:{},serverResources:{}},hostContext:{theme:'light',displayMode:'fullscreen',availableDisplayModes:['fullscreen']}}}))window.status=status})();
      },{sourceUrl,address,bytes,html});
      const output=page.frameLocator('iframe').locator('output');await output.filter({hasText:expectedError??'fresh PR data'}).waitFor();
      assert.equal(await page.evaluate(()=>resourceCalls),expectedReads,'Content-addressed static reads across navigation');
      assert.equal(await page.evaluate(()=>privateCalls),expectedError?0:1,'Every mount reads fresh PR data');
      if(!expectedError)assert.equal(JSON.parse(await output.innerText()).asset,bytes);
      calls+=expectedReads;privateCalls+=expectedError?0:1;
      await page.evaluate(()=>controller.abort());
    }
    console.log('Code Review resources: immutable reuse, changed version, source isolation, hash rejection/retry, uncached private reads; '+calls+' resource reads, '+privateCalls+' fresh PR reads.');
  }finally{await browser.close();await server.close()}
})().catch(error=>{console.error(error);process.exitCode=1});
