const http = require('node:http');
const assert = require('node:assert/strict');
const {buildSync} = require('esbuild');
const {chromium} = require('@playwright/test');

async function main() {
  const {patchSub2ApiTrigger} = await import('./sub2api-ui-patch.mjs');
  const trigger = await patchSub2ApiTrigger(`
var cPo;
function iPo(e) {
  let De = Ee, unused;
  let ke = Oe, other;
  const unavailable = ke == null || j;
  return {src: ce ? null : me, profile: ke};
}
`);
  const bundle = buildSync({stdin: {contents: `
import React from 'react';
import {createRoot} from 'react-dom/client';
${trigger}
cPo = React;
function Profile() {
  const profile = iPo({}).profile;
  return React.createElement('output', null, JSON.stringify(profile));
}
createRoot(document.getElementById('root')).render(React.createElement(React.Fragment, null, React.createElement(Profile), React.createElement(Profile)));
`, resolveDir: process.cwd(), loader: 'js'}, bundle: true, write: false, format: 'iife', target: 'es2022'}).outputFiles[0].text;

  const server = http.createServer((request, response) => {
    response.setHeader('content-type', 'text/html;charset=utf-8');
    response.end('<!doctype html><div id="root"></div><script>' + bundle.replaceAll('</script', '<\\/script') + '</script>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({channel: 'chrome', headless: true});
  try {
    for (const scenario of [
      {name: 'GitHub login', status: 200, user: {github: 'FixtureDeveloper', email: 'developer@example.invalid'}, expected: {displayName: 'FixtureDeveloper', isProfileAvailable: false, profileImageUrl: 'https://github.com/FixtureDeveloper.png?size=64'}},
      {name: 'authenticated email login', status: 200, user: {github: null, email: 'member@example.invalid'}, expected: {displayName: 'member@example.invalid', isProfileAvailable: false, profileImageUrl: null}},
      {name: 'anonymous login', status: 200, user: null, expected: null},
      {name: 'expired login', status: 401, user: null, expected: null},
    ]) {
      const context = await browser.newContext();
      const page = await context.newPage();
      const requests = [], errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/maa/api/auth/me', async route => {
        requests.push({url: route.request().url(), method: route.request().method(), authorization: route.request().headers().authorization});
        await route.fulfill({status: scenario.status, json: {user: scenario.user}});
      });
      const read = page.waitForResponse(origin + '/maa/api/auth/me');
      await page.goto(origin + '/?token=must-not-forward');
      await (await read).finished();
      await page.waitForFunction(() => document.querySelectorAll('output').length === 2);
      if (scenario.expected) await page.waitForFunction(() => [...document.querySelectorAll('output')].every(element => element.textContent !== 'null'));
      else await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      for (const output of await page.locator('output').allTextContents()) assert.deepEqual(JSON.parse(output), scenario.expected, scenario.name);
      assert.deepEqual(requests, [{url: origin + '/maa/api/auth/me', method: 'GET', authorization: undefined}], 'Both profile consumers share one same-origin authenticated read without URL or bearer tokens');
      assert.deepEqual(errors, []);
      console.log('PASS ' + scenario.name);
      await context.close();
    }
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => {console.error(error); process.exitCode = 1;});
