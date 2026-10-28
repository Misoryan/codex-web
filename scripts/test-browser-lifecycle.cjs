const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require('@playwright/test');

// Exercise the lifecycle scripts emitted by the actual Full/Lite build.
// Authentication and telemetry receivers are external to this browser boundary.
(async () => {
  const browser = await chromium.launch({channel:'chrome',headless:true});
  const reports=[];
  try {
    for (const prefix of ['', 'lite/']) for (const fault of ['none','beacon-throws','beacon-rejected','auth-unavailable','access-forbidden','auth-required']) {
      const html=fs.readFileSync(path.join(process.argv[2]||'scratch/asar/webview',prefix,'index.html'),'utf8');
      const scripts=[...html.matchAll(/<script data-(connection-telemetry|startup-status)>[\s\S]*?<\/script>/g)].map(m=>m[0]);
      assert.equal(scripts.length,2,'Both built entries must include startup and telemetry scripts');
      const context=await browser.newContext({serviceWorkers:'block'});
      const page=await context.newPage(),errors=[],records=[],auth=[],profiles=[];
      const denied=['access-forbidden','auth-required'].includes(fault);
      if(denied)await page.clock.install();
      page.on('pageerror',e=>errors.push(e.message));
      const fixedAt=Date.now();
      // Only Date is controlled for access recheck. Navigation/Resource Timing
      // must remain the browser's real measurements.
      await context.addInitScript(now=>{window.fixtureNow=now;Date.now=()=>window.fixtureNow;},fixedAt);
      await context.addInitScript(({fault})=>{
        if(fault==='beacon-throws')navigator.sendBeacon=()=>{throw Error('diagnostics unavailable');};
        if(fault==='beacon-rejected')navigator.sendBeacon=()=>false;
      },{fault});
      await context.route('https://example.com/**',async route=>{
        const request=route.request(),url=new URL(request.url());
        if(url.pathname==='/maa/api/auth/me'){
          profiles.push(request.url());return route.fulfill({status:403});
        }
        if(url.pathname==='/__backend/health'){
          auth.push({method:request.method(),cache:request.headers()['cache-control']});
          if(denied)return route.fulfill({status:fault==='access-forbidden'?403:401});
          return fault==='auth-unavailable'?route.abort():route.fulfill({json:{ok:true}});
        }
        if(url.pathname==='/__backend/telemetry'){
          records.push(JSON.parse(request.postData()));
          return route.fulfill({status:204});
        }
        if(url.pathname==='/assets/fixture.js')return route.fulfill({contentType:'application/javascript',body:'window.fixtureAssetLoaded=true;'});
        assert.equal(request.method(),'GET');
        return route.fulfill({contentType:'text/html; charset=utf-8',body:`<!doctype html><head><meta charset="utf-8"><script>window.__codexStartupAssets={'/assets/fixture.js':30}</script>${scripts.join('\n')}<script src="/assets/fixture.js?private-query"></script></head><body>${denied?'':'<div contenteditable="true" id="draft">private unsent draft</div>'}</body>`});
      });
      await context.routeWebSocket('wss://example.com/__backend/native/ipc*',socket=>socket.onMessage(()=>socket.send('fixture frame')));
      try {
        await page.goto('https://example.com/'+prefix);
        if(denied){
          await page.waitForFunction(status=>window.__codexStartupDiagnostics.authStatus===status,fault==='access-forbidden'?403:401);
          await page.clock.runFor(13000);
          const text=await page.locator('aside').innerText();
          assert(text.includes(fault==='access-forbidden'?'当前入口拒绝访问':'访问认证未通过'));
          assert(!text.includes('登录已失效'));
          assert.equal(await page.locator('a[href*="oauth2"]').count(),0,'Do not invent an OAuth route for the current gateway');
          assert.deepEqual(profiles,[]);
          reports.push({entry:prefix||'full',fault,accessStatus:await page.evaluate(()=>__codexStartupDiagnostics.authStatus)});
          continue;
        }
        await page.waitForFunction(()=>window.__codexStartupDiagnostics.composerMs!=null);
        if(fault==='auth-unavailable')await page.waitForFunction(()=>window.__codexStartupDiagnostics.authStatus==='连接超时');
        else await page.waitForFunction(()=>window.__codexStartupDiagnostics.authStatus===200);
        if(fault==='auth-unavailable')assert(auth.length>=1,'Failed access checks may retry on pageshow');
        else assert.equal(auth.length,1,'Initial page load checks access');
        await page.evaluate(()=>{dispatchEvent(new Event('pageshow'));document.dispatchEvent(new Event('visibilitychange'));});
        if(fault!=='auth-unavailable'){
          await page.waitForTimeout(50);
          assert.equal(auth.length,1,'Returning within an hour does not repeat access checks');
          await page.evaluate(now=>{window.fixtureNow=now;},fixedAt+3601000);
          const renewed=page.waitForResponse('**/__backend/health');
          await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
          await renewed;
          assert.equal(auth.length,2,'Foreground return after an hour checks access');
        }
        if(fault==='none'){
          const closed=page.waitForResponse(r=>r.url().endsWith('/__backend/telemetry')&&JSON.parse(r.request().postData()).event==='close');
          await page.evaluate(()=>new Promise(resolve=>{
            const socket=new WebSocket('wss://example.com/__backend/native/ipc?session=11111111-1111-4111-8111-111111111111&document=22222222-2222-4222-8222-222222222222');
            socket.addEventListener('open',()=>socket.send('fixture request'));
            socket.addEventListener('message',()=>socket.close(1000,'Document closed'));
            socket.addEventListener('close',resolve);
          }));
          await closed;
          for(const event of ['visit','ready','open','close','navigation','resources_ready','first_message'])assert(records.some(r=>r.event===event),'Missing browser event '+event);
          const assets=records.find(r=>r.event==='resources_ready');
          assert.equal(assets.assetCount,1);assert.equal(assets.assetsComplete,1);assert(assets.assetEncodedBytes>0);
          assert(!JSON.stringify(records).includes('private-query'));
          assert(records.find(r=>r.event==='ready').durationMs>=0);
          assert(!JSON.stringify(records).includes('private unsent draft'));
          assert(!JSON.stringify(records).includes('fixture frame'));
        }
        assert.equal(await page.locator('#draft').innerText(),'private unsent draft');
        assert.deepEqual(profiles,[],'A forbidden profile service cannot determine Codex access');
        assert.deepEqual(errors,[],'Optional lifecycle requests cannot break the page');
        reports.push({entry:prefix||'full',fault,renewals:auth.length,events:[...new Set(records.map(r=>r.event))],draftPreserved:true});
      } catch(error) {
        console.error(JSON.stringify({entry:prefix||'full',fault,errors,url:page.url(),scripts:await page.locator('script').count(),events:records.map(r=>r.event),timing:await page.evaluate(()=>({navigation:performance.getEntriesByType('navigation').map(e=>({responseEnd:e.responseEnd,dom:e.domContentLoadedEventEnd})),resources:performance.getEntriesByType('resource').map(e=>({end:e.responseEnd,bytes:e.decodedBodySize}))}))}));
        throw error;
      } finally {await context.close();}
    }
    fs.writeFileSync('runtime/browser-lifecycle.json',JSON.stringify({passed:true,reports},null,2));
    console.log(JSON.stringify({passed:true,scenarios:reports.length}));
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
