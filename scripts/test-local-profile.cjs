const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const Fastify = require('fastify');
const {registerLocalProfile} = require('../src/server/local-profile.js');

(async () => {
  const original = process.cwd();
  const directory = await fs.mkdtemp(path.join(original, 'runtime/tmp/local-profile-'));
  const app = Fastify();
  try {
    process.chdir(directory);
    await fs.mkdir('runtime/private', {recursive: true});
    await registerLocalProfile(app);
    const read = (headers = {}, remoteAddress = '127.0.0.1') => app.inject({
      url: '/maa/api/auth/me', remoteAddress, headers: {host: '127.0.0.1:8222', ...headers},
    });
    assert.deepEqual((await read()).json(), {user: null});
    await fs.writeFile('runtime/private/local-profile.json', JSON.stringify({github: 'FixtureDeveloper', secret: 'must-not-be-returned'}));
    const profile = await read({origin: 'http://127.0.0.1:8222', 'sec-fetch-site': 'same-origin'});
    assert.equal(profile.statusCode, 200);
    assert.match(profile.headers['content-type'], /application\/json/);
    assert.equal(profile.headers['cache-control'], 'private, no-store');
    assert.deepEqual(profile.json(), {user: {github: 'FixtureDeveloper'}});
    for (const headers of [
      {host: 'public.example'}, {origin: 'https://attacker.invalid'}, {origin: 'null'},
      {'sec-fetch-site': 'cross-site'}, {'forwarded': 'for=127.0.0.1'},
      {'x-forwarded-for': '127.0.0.1'}, {'x-forwarded-host': 'public.example'},
    ]) assert.equal((await read(headers)).statusCode, 403);
    assert.equal((await read({}, '192.0.2.1')).statusCode, 403);
    assert.equal((await read({host: '[::1]:8222'}, '::1')).statusCode, 200);
    await fs.writeFile('runtime/private/local-profile.json', '{"github":"invalid/name"}');
    assert.equal((await read()).statusCode, 503);
    await fs.writeFile('runtime/private/local-profile.json', 'broken-json');
    assert.equal((await read()).statusCode, 503);
    console.log('PASS: direct local identity is JSON, private fields excluded, public/proxied/cross-site requests rejected, invalid configuration reported');
  } finally {
    await app.close();
    process.chdir(original);
    // The caller removes this task-owned fixture directory after the run.
    console.log('Fixture directory: ' + directory);
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
