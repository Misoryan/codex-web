const assert = require('node:assert/strict');
const {gunzipSync,gzipSync} = require('node:zlib');
const {registerFeatureConfig} = require('../src/server/feature-config.js');

(async () => {
 const app = require('fastify')();
 const calls = [];
 let release, status = 200, fail = false;
 let gate = new Promise(resolve => { release = resolve; });
 const payload = {has_updates: true, feature_gates: {}, text: '中文配置'.repeat(10000)};
 await registerFeatureConfig(app, async (url, options) => {
  calls.push({url: String(url), options});
  await gate;
  if (fail) throw Error('private upstream failure');
  return new Response(status === 204 ? null : JSON.stringify(payload), {status, headers: {'retry-after':'12'}});
 });
 const request = (userID = 'fixture-a', headers = {}) => app.inject({
  method: 'POST', url: '/__backend/feature-config?k=fixture', payload: {user: {userID}},
  headers: {host: 'app.example.org', origin: 'https://app.example.org', authorization: 'Bearer gateway-secret', cookie: 'session=secret',
   'statsig-api-key': 'client-fixture', 'accept-encoding': 'gzip', ...headers},
 });
 try {
  const concurrent = [request(), request(), request('fixture-b')];
  while (calls.length < 2) await new Promise(resolve => setTimeout(resolve, 5));
  release();
  const results = await Promise.all(concurrent);
  assert.equal(calls.length, 2, 'Only identical concurrent evaluations coalesce');
  for (const result of results) {
   assert.equal(result.statusCode, 200);
   assert.deepEqual(JSON.parse(gunzipSync(result.rawPayload)), payload);
   assert.equal(result.headers['cache-control'], 'private, no-store');
   assert.equal(result.headers.vary, 'Accept-Encoding');
   assert(result.rawPayload.length < JSON.stringify(payload).length / 10);
  }
  for (const {url, options} of calls) {
   assert.equal(url, 'https://ab.chatgpt.com/v1/initialize?k=fixture');
   assert.equal(options.headers.authorization, undefined);
   assert.equal(options.headers.cookie, undefined);
   assert.equal(options.headers['statsig-api-key'], 'client-fixture');
   assert.equal(options.method, 'POST');
   assert.equal(options.redirect, 'error');
  }
  assert.deepEqual(calls.map(c => JSON.parse(Buffer.from(c.options.body).toString()).user.userID).sort(), ['fixture-a', 'fixture-b']);
  const raw = await request('fixture-a', {'accept-encoding': 'gzip;q=0, identity'});
  assert.equal(calls.length, 3, 'Completed responses are not shared across subsequent evaluations');
  assert.equal(raw.headers['content-encoding'], undefined);
  assert.deepEqual(raw.json(), payload);
  for (const headers of [{origin: 'https://evil.example.org'}, {origin: 'null'}, {'sec-fetch-site': 'cross-site'}])
   assert.equal((await request('fixture-a', headers)).statusCode, 403);
  assert.equal(calls.length, 3, 'Cross-site requests never reach upstream');
  assert.equal((await app.inject({method: 'POST', url: '/__backend/feature-config', headers: {'content-type':'application/json'}, payload: ''})).statusCode, 400);
  const encoded = gzipSync('{"user":{"userID":"encoded-fixture"}}');
  assert.equal((await app.inject({method:'POST',url:'/__backend/feature-config?gz=1',headers:{'content-type':'application/json'},payload:encoded})).statusCode,200);
  assert.deepEqual(Buffer.from(calls.at(-1).options.body),encoded,'SDK encoded request bytes are preserved');
  assert.equal(calls.at(-1).url,'https://ab.chatgpt.com/v1/initialize?gz=1');
  status = 429;
  const limited = await request();
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.headers['retry-after'],'12');
  status = 204; assert.equal((await request()).body, '');
  fail = true;
  const unavailable = await request();
  assert.equal(unavailable.statusCode, 502);
  assert.deepEqual(unavailable.json(), {error: 'Feature configuration unavailable'});
  fail = false; status = 200;
  assert.equal((await request()).statusCode, 200, 'A failed inflight request is evicted');
  console.log('Feature configuration HTTP boundary passed: coalescing, identity separation, compression, secret isolation, rejection and recovery');
 } finally { await app.close(); }
})().catch(error => {console.error(error); process.exitCode = 1;});
