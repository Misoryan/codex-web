const {test,after}=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter,once}=require('node:events');
require('../src/server/background-processes').hideBackgroundProcessWindows();
const {BrowserGuest,browserGuests}=require('../src/server/browser-guest');
const {installBrowserGuestIpc}=require('../src/server/browser-stream');
let browser;
after(async()=>{await browser?.close();});

test('page rendering and CDP use the same isolated guest',async()=>{
  const owner=new EventEmitter(),guest=await BrowserGuest.create(owner,1,{});
  browser=guest.page.context().browser();
  try {
    await guest.page.setContent('<title>Guest test</title><input id="value"><div style="background:green;width:200px;height:200px"></div>');
    guest.debugger.attach();
    const value=await guest.debugger.sendCommand('Runtime.evaluate',{expression:'document.querySelector("input").value="CDP write"',returnByValue:true});
    assert.equal(value.result.value,'CDP write');
    assert.equal(await guest.page.locator('input').inputValue(),'CDP write');
    const screenshot=await guest.debugger.sendCommand('Page.captureScreenshot',{format:'png'});
    assert(Buffer.from(screenshot.data,'base64').length>1000);
    assert.equal(browserGuests.get(guest.id),guest);
    const other=await BrowserGuest.create(new EventEmitter(),2,{});
    try{assert.equal(await other.page.locator('input').count(),0);}finally{other.destroy();}
  }finally{guest.destroy();}
  assert(!browserGuests.has(guest.id));
});

test('guest attachment preserves native host validation',async()=>{
  const handlers=new Map();
  installBrowserGuestIpc({handle:(key,handler)=>handlers.set(key,handler)});
  const owner=new EventEmitter();
  owner.on('will-attach-webview',event=>event.preventDefault());
  await assert.rejects(handlers.get('codex-web:attach-browser')({sender:owner},{partition:'test','data-browser-sidebar-browser-tab-id':'tab','data-browser-sidebar-conversation-id':'task'}),/rejected/);
  assert.throws(()=>handlers.get('codex-web:close-browser')({sender:owner},'unknown'),/owner mismatch/);
});
