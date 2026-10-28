const assert = require('node:assert/strict');
const http = require('node:http');
const {buildSync} = require('esbuild');
const {chromium} = require('@playwright/test');

// Real usage component + React. Only the menu shell and HTTP service are fixtures.
const bundle = buildSync({stdin: {contents: `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {createSub2ApiUsage} from './src/browser/sub2api-usage.js';
const Menu = {Item: ({children, onSelect, LeftIcon, rightIcon, ...props}) => React.createElement('button', {...props, onClick: onSelect}, children), Separator: () => null};
const Disclosure = ({trigger, children}) => React.createElement('section', null, trigger, children);
const Usage = createSub2ApiUsage(React, Menu, Disclosure, () => null);
function App() {
 const [active, setActive] = React.useState(true);
 return React.createElement(React.Fragment, null,
   React.createElement('button', {id:'toggle', onClick:()=>setActive(value=>!value)}, 'Toggle'),
   active ? React.createElement(Usage) : null);
}
createRoot(document.getElementById('root')).render(React.createElement(App));
`, resolveDir: process.cwd()}, bundle:true, write:false, format:'iife', target:'es2022'}).outputFiles[0].text;

(async () => {
 const server = http.createServer((req, res) => {res.setHeader('content-type','text/html;charset=utf-8');res.end('<div id="root"></div><script>'+bundle.replaceAll('</script','<\\/script')+'</script>');});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const browser = await chromium.launch({channel:'chrome',headless:true});
 try {
  const page = await browser.newPage({locale:'en-US'}), errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.clock.install();
  const date = new Date(Date.now()+8*3600000).toISOString().slice(0,10);
  const response = (range, cost=12) => ({enabled:true, stale:false,
   report:{range,shareBasis:'actual_cost',startDate:range==='month'?date.slice(0,7)+'-01':date,endDate:date,
    self:{userId:1,actualCost:cost,share:50,rank:1},ranking:[]},
   capacity:{report:{remainingPercent:275},nextRefreshAt:new Date(Date.now()+3600000).toISOString()},
   nextRefreshAt:new Date(Date.now()+3600000).toISOString()});
  const calls={today:0,week:0,month:0}, held={};
  let mode='initial';
  await page.route('**/__backend/sub2api/usage?*',async route=>{
   const range=new URL(route.request().url()).searchParams.get('range'); calls[range]++;
   if(mode==='initial' && range==='month') {held.month=route;return;}
   if(range==='week' && mode==='initial') return route.abort('failed');
   if(mode==='hold') {held[range]=route;return;}
   return route.fulfill({json:response(range,mode==='recovered'?34:12)});
  });
  await page.goto('http://127.0.0.1:'+server.address().port);
  await page.locator('[data-sub2api-cost="today"]').filter({hasText:'12.00'}).waitFor();
  assert.equal(await page.locator('[data-sub2api-remaining]').innerText(),'275%');
  assert.equal(await page.locator('[data-sub2api-cost="month"]').innerText(),'—');
  await page.getByText('Loading usage…',{exact:true}).waitFor();
  await page.getByText('Refresh failed; keeping the last successful data',{exact:true}).waitFor();
  assert.equal(calls.month,1);
  // A failed week retries while month is still pending, without duplicating month.
  mode='retry'; await page.clock.runFor(5100);
  await page.locator('[data-sub2api-rank="week"]').filter({hasText:'#1'}).waitFor();
  assert.equal(calls.week,2); assert.equal(calls.month,1);
  // A response arriving while the menu is inactive is visible immediately on reopen.
  await page.locator('#toggle').click();
  const monthReceived=page.waitForResponse(r=>r.url().includes('range=month'));
  await held.month.fulfill({json:response('month')});
  await monthReceived;
  delete held.month;
  await page.locator('#toggle').click();
  await page.locator('[data-sub2api-cost="month"]').filter({hasText:'12.00'}).waitFor();
  assert.deepEqual(calls,{today:1,week:2,month:1});
  // Expire the real component's cache. Failed refresh retains successful values.
  mode='hold'; await page.clock.runFor(3600001);
  for(const range of ['today','week','month']) {
   for(let i=0;!held[range] && i<100;i++) await new Promise(resolve=>setTimeout(resolve,10));
   assert(held[range],range+' refresh starts');
  }
  await held.today.abort('failed');
  await page.getByText('Refresh failed; keeping the last successful data',{exact:true}).waitFor();
  assert.match(await page.locator('[data-sub2api-cost="today"]').innerText(),/12\.00/);
  mode='recovered';
  await page.evaluate(()=>{for(let i=0;i<5;i++)window.dispatchEvent(new Event('online'));});
  await page.locator('[data-sub2api-cost="today"]').filter({hasText:'34.00'}).waitFor();
  assert.equal(calls.today,3,'online recovers once, without waiting for backoff or pending month');
  assert.equal(calls.month,2,'online does not duplicate pending requests');
  await held.week.fulfill({json:response('week',34)});
  await held.month.fulfill({json:response('month',34)});
  await page.locator('[data-sub2api-cost="month"]').filter({hasText:'34.00'}).waitFor();
  assert.deepEqual(errors,[]);
  console.log('PASS: independent display/retries, loading feedback, reopen cache, failure retention, online recovery and request coalescing');
 } finally {await browser.close(); await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
