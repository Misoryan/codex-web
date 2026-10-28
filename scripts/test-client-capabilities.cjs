const assert = require('node:assert/strict');
const fs = require('node:fs');
const {chromium} = require('playwright-core');

(async () => {
  const browser = await chromium.launch({channel: 'chrome', headless: true});
  try {
    const context = await browser.newContext({permissions: ['clipboard-read', 'clipboard-write']});
    await context.route('https://client.example.invalid/**', route => route.fulfill({
      contentType: route.request().url().endsWith('.js') ? 'text/javascript' : 'text/html',
      body: route.request().url().endsWith('.js') ? fs.readFileSync('src/browser/client-capabilities.js', 'utf8') : '<button>Copy</button>',
    }));
    const page = await context.newPage();
    await page.goto('https://client.example.invalid/');
    await page.evaluate(async () => {
      window.client = await import('/client.js');
      window.remoteCalls = [];
      window.services = client.codexWebClientServices({
        clipboard: {writeText: () => {remoteCalls.push('write'); throw Error('Remote clipboard must not run');}, readText: () => {remoteCalls.push('read'); throw Error('Remote clipboard must not run');}},
        serverWork: {identity: 'remote host'},
      });
    });
    await page.evaluate(() => services.clipboard.writeText('Local text 你好'));
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'Local text 你好');
    await page.evaluate(() => navigator.clipboard.writeText('Client paste'));
    assert.equal(await page.evaluate(() => services.clipboard.readText()), 'Client paste');
    assert.deepEqual(await page.evaluate(() => ({calls: remoteCalls, host: services.serverWork.identity, bookmark: services.clipboard.bookmark ?? null})), {calls: [], host: 'remote host', bookmark: null});
    await page.evaluate(() => document.querySelector('button').onclick = () => {
      window.copy = client.codexWebWriteText(new Promise(resolve => setTimeout(() => resolve('Delayed copy'), 100)));
    });
    await page.click('button');
    await page.evaluate(() => window.copy);
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'Delayed copy');
    const rejection = await page.evaluate(async () => {
      const write = navigator.clipboard.writeText;
      navigator.clipboard.writeText = () => Promise.reject(new DOMException('Denied', 'NotAllowedError'));
      try {await services.clipboard.writeText('must not succeed'); return 'unexpected success';}
      catch (error) {return error.name;}
      finally {navigator.clipboard.writeText = write;}
    });
    assert.equal(rejection, 'NotAllowedError');
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'Delayed copy');
    for (const [platform, ua, touch, expected] of [
      ['Win32', 'Windows', 0, 'win32'], ['MacIntel', 'Macintosh', 0, 'darwin'],
      ['Linux x86_64', 'Linux', 0, 'linux'], ['Linux armv8l', 'Android', 5, 'android'],
      ['iPhone', 'iPhone', 5, 'ios'], ['MacIntel', 'Macintosh', 5, 'ios'],
    ]) {
      const result = await page.evaluate(({platform, ua, touch}) => {
        Object.defineProperties(navigator, {userAgentData: {value: undefined, configurable: true}, platform: {value: platform, configurable: true}, userAgent: {value: ua, configurable: true}, maxTouchPoints: {value: touch, configurable: true}});
        const bridge = {windowType: 'electron', startFileDrag() {}, startLinkDrag() {}, getDesktopUserAgent: () => 'wrong', isIntelMacBuild: () => true};
        client.codexWebInstallClientBridge(bridge);
        return {client: window.codexWebClient, ua: bridge.getDesktopUserAgent(), drag: 'startLinkDrag' in bridge, fileDrag: 'startFileDrag' in bridge, transport: bridge.windowType};
      }, {platform, ua, touch});
      assert.deepEqual(result, {client: {kind: 'browser', platform: expected}, ua: null, drag: false, fileDrag: false, transport: 'electron'});
    }
    assert.equal(await page.evaluate(() => {window.codexElectron = {windowAction() {}};client.codexWebInstallClientBridge({});return window.codexWebClient.kind;}), 'electron');
    console.log('Client clipboard write/read, delayed content, denied permission, remote isolation, and six platform profiles passed.');
  } finally {await browser.close();}
})().catch(error => {console.error(error); process.exitCode = 1;});
