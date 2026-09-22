import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.mjs';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { feed, catalog, book } from './fixtures.mjs';
const password = 'isolated-test-password-only';
async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'crossex-http-test-'));
  const app = createApp({ dataDir: directory, initialPassword: password, intervalMs: 0, engineOptions: { feedReader: async () => feed(Date.now()), catalogReader: async () => catalog, depthReader: async q => book(q, Date.now()) } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`; let csrf = '';
  async function request(path, { method = 'GET', body, auth = true, originHeader = origin, csrfHeader = csrf, headers = {} } = {}) {
    const res = await fetch(origin + path, { method, headers: { ...(auth ? { Authorization: `Basic ${Buffer.from(`admin:${password}`).toString('base64')}` } : {}), ...(originHeader ? { Origin: originHeader } : {}), ...(csrfHeader ? { 'X-CSRF-Token': csrfHeader } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const data = await res.json(); if (data.csrfToken) csrf = data.csrfToken; return { status: res.status, data };
  }
  t.after(async () => { await app.close(); if (!directory.startsWith(tmpdir()) || !directory.includes('crossex-http-test-')) throw new Error('unsafe path'); rmSync(directory, { recursive: true, force: true }); });
  return { app, directory, request };
}
test('health is public; state and summaries require module authentication', async t => {
  const f = await fixture(t); assert.equal((await f.request('/api/health', { auth: false })).data.liveTradingAvailable, false);
  for (const path of ['/api/state', '/api/hub/summary']) assert.equal((await f.request(path, { auth: false })).status, 401);
  assert.equal((await f.request('/api/state')).status, 200);
});
test('writes require same-origin JSON and csrf; no real execution endpoint exists', async t => {
  const f = await fixture(t); await f.request('/api/state');
  const body = { config: { enabled: true } };
  assert.equal((await f.request('/api/settings', { method: 'PUT', body, originHeader: 'https://evil.example' })).status, 403);
  assert.equal((await f.request('/api/settings', { method: 'PUT', body, originHeader: '' })).status, 403);
  assert.equal((await f.request('/api/settings', { method: 'PUT', body, csrfHeader: '' })).status, 403);
  assert.equal((await f.request('/api/settings', { method: 'PUT', body, headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await f.request('/api/settings', { method: 'PUT', body })).status, 200);
  assert.equal((await f.request('/api/live/orders', { method: 'POST', body: {} })).status, 404);
});
test('summary never marks absent data fresh, secrets never enter public state or plaintext DB', async t => {
  const f = await fixture(t); assert.equal((await f.request('/api/hub/summary')).data.data.updatedAt, '1970-01-01T00:00:00.000Z');
  await f.request('/api/state'); await f.request('/api/settings', { method: 'PUT', body: { config: {}, monitorPassword: 'not-a-real-monitor-secret' } });
  assert.doesNotMatch(JSON.stringify((await f.request('/api/state')).data), /not-a-real-monitor-secret/);
  assert.equal(readFileSync(join(f.directory, 'crossex.sqlite')).includes(Buffer.from('not-a-real-monitor-secret')), false);
  await f.app.engine.tick(); const summary = (await f.request('/api/hub/summary')).data; assert.equal(summary.schemaVersion, 1); assert.deepEqual(Object.keys(summary.data).sort(), ['metrics', 'updatedAt']);
});
test('reset revokes cached Basic authorization immediately', async t => {
  const f = await fixture(t); await f.request('/api/state'); f.app.resetPassword(); assert.equal((await f.request('/api/state')).status, 401);
});
test('HTTP open and close are idempotent across repeated delivery', async t => {
  const f = await fixture(t); await f.request('/api/state'); await f.app.engine.tick();
  const signalId = f.app.engine.view().opportunities[0].id, body = { signalId, requestId: 'http-open-test-id' };
  const first = await f.request('/api/open', { method: 'POST', body }), second = await f.request('/api/open', { method: 'POST', body });
  assert.equal(first.status, 200); assert.equal(first.data.id, second.data.id); assert.equal(f.app.engine.view().totals.openCount, 1);
});
test('wrong-password bursts do not lock out a subsequent correct login', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 11; i++) await f.request('/api/state', { headers: { Authorization: `Basic ${Buffer.from(`admin:incorrect-${i}`).toString('base64')}` } });
  assert.equal((await f.request('/api/state')).status, 200);
});
