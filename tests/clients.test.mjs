import test from 'node:test';
import assert from 'node:assert/strict';
import { getJson } from '../server/clients.mjs';
test('outbound reader only uses GET, bounded responses, deadlines and no redirects', async () => {
  let init; assert.deepEqual(await getJson('http://localhost', { fetcher: async (_url, value) => { init = value; return new Response('{"ok":true}'); } }), { ok: true });
  assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error'); assert.ok(init.signal);
  await assert.rejects(getJson('http://localhost', { fetcher: async () => new Response('x'.repeat(20)), maxBytes: 10 }), /过大/);
  await assert.rejects(getJson('http://localhost', { fetcher: async () => new Response('not json') }), /JSON/);
  await assert.rejects(getJson('http://localhost', { fetcher: async () => new Response('{}', { status: 401 }) }), /认证/);
});
