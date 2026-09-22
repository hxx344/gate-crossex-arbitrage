import http from 'node:http';
import { randomBytes, scryptSync, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from './store.mjs';
import { createEngine } from './engine.mjs';
import { AppError } from './model.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const digest = value => createHash('sha256').update(value).digest();
const equal = (a, b) => timingSafeEqual(digest(a), digest(b));
const makePassword = value => { const salt = randomBytes(16).toString('hex'); return `${salt}:${scryptSync(value, salt, 64).toString('hex')}`; };
const derive = promisify(scrypt);
const matches = async (value, record) => { const [salt, encoded] = record.split(':'); return timingSafeEqual(await derive(value, salt, 64), Buffer.from(encoded, 'hex')); };
async function body(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw new AppError('请使用 JSON 请求', 415);
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 16384) throw new AppError('请求过大', 413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new AppError('请求格式无效'); }
}
export function createApp({ dataDir = process.env.DATA_DIR || path.join(root, '.data'), initialPassword = process.env.INITIAL_PASSWORD, publicOrigin = process.env.PUBLIC_ORIGIN || '', intervalMs = 5000, engineOptions, logger = console.log, distDir = path.join(root, 'dist') } = {}) {
  const store = createStore(dataDir);
  if (!store.get('password')) {
    const value = initialPassword || randomBytes(18).toString('base64url');
    if (typeof value !== 'string' || value.length < 12 || value.length > 1024) { store.close(); throw new Error('INITIAL_PASSWORD 需要 12–1024 个字符'); }
    store.set('password', makePassword(value));
    if (!initialPassword) logger(`CrossEx 初始登录信息：admin / ${value}\n首次显示，请保存。重置：node server/setup.mjs --reset-password`);
  }
  const engine = createEngine(store, engineOptions), csrf = randomBytes(32).toString('base64url');
  let validAuth = null, authRecord = null, failed = 0, failedAt = 0, checkingAuth = 0, runningTick = false, stopping = false;
  const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
  const runTick = async () => {
    if (stopping) return;
    // Keep the source current even while a catalog or simulation depth read is slow.
    const refresh = engine.refreshSource();
    if (runningTick) return;
    runningTick = true;
    try { await refresh; await engine.tick({ refreshSource: false }); }
    catch { logger('模拟服务本轮未完成，等待下一次检查'); }
    finally { runningTick = false; }
  };
  const timer = intervalMs > 0 ? setInterval(runTick, intervalMs) : null; timer?.unref();
  if (intervalMs > 0) void runTick();
  async function authenticate(req) {
    const record = store.get('password');
    if (authRecord !== record) { validAuth = null; authRecord = record; failed = 0; }
    const authorization = req.headers.authorization || '';
    if (validAuth && equal(authorization, validAuth)) return true;
    if (Date.now() - failedAt > 900000) { failed = 0; failedAt = Date.now(); }
    if (!authorization.startsWith('Basic ') || authorization.length > 2048) return false;
    const decoded = Buffer.from(authorization.slice(6), 'base64').toString('utf8'), colon = decoded.indexOf(':');
    if (checkingAuth >= 4) throw new AppError('登录校验繁忙，请稍后重试', 429);
    checkingAuth++;
    try {
      if (decoded.slice(0, colon) === 'admin' && await matches(decoded.slice(colon + 1), record) && record === store.get('password')) { validAuth = authorization; failed = 0; return true; }
      failed++; if (failed >= 10) throw new AppError('登录信息不正确，请检查密码后重试', 429);
      return false;
    } finally { checkingAuth--; }
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'");
    try {
      const url = new URL(req.url, 'http://localhost'), route = url.pathname;
      if (route === '/api/health' && req.method === 'GET') return json(res, 200, { status: 'ok', mode: 'paper', liveTradingAvailable: false });
      if (!await authenticate(req)) { res.setHeader('WWW-Authenticate', 'Basic realm="Gate CrossEx paper", charset="UTF-8"'); return json(res, 401, { error: '需要模块登录信息' }); }
      if (!['GET', 'HEAD'].includes(req.method)) {
        const expected = publicOrigin || `http://${req.headers.host}`;
        if (req.headers.origin !== expected || req.headers['sec-fetch-site'] === 'cross-site' || !equal(req.headers['x-csrf-token'] || '', csrf)) throw new AppError('操作来源或会话校验失败，请刷新页面', 403);
      }
      if (route === '/api/state' && req.method === 'GET') return json(res, 200, { ...engine.view({ includeHistory: url.searchParams.get('history') !== '0', historyVersion: url.searchParams.get('historyVersion') }), csrfToken: csrf });
      if (route === '/api/hub/summary' && req.method === 'GET') {
        if (url.searchParams.get('schemaVersion') === '2') return json(res, 200, { schemaVersion: 2, data: engine.summary() });
        const value = engine.summary();
        return json(res, 200, { schemaVersion: 1, data: { updatedAt: value.updatedAt || new Date(0).toISOString(), metrics: value.metrics } });
      }
      if (route === '/api/settings' && req.method === 'PUT') return json(res, 200, await engine.settings(await body(req)));
      if (route === '/api/open' && req.method === 'POST') { const input = await body(req); return json(res, 200, await engine.open(input.signalId, input.requestId)); }
      if (route === '/api/close' && req.method === 'POST') { const input = await body(req); return json(res, 200, await engine.closePosition(input.positionId, input.requestId)); }
      if (route.startsWith('/api/')) throw new AppError('不支持此接口或请求方法', 404);
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new AppError('不支持此请求方法', 405);
      const asset = route === '/' ? 'index.html' : route.replace(/^\//, '');
      if (!/^(?:index\.html|favicon\.svg|assets\/[A-Za-z0-9_.-]+)$/.test(asset)) throw new AppError('页面不存在', 404);
      let content; try { content = await readFile(path.join(distDir, asset)); } catch { throw new AppError('页面尚未构建或文件不存在', 404); }
      const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
      if (/^assets\/[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8,}\.(?:js|css)$/.test(asset)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.writeHead(200, { 'Content-Type': types[path.extname(asset)] || 'application/octet-stream' }); res.end(req.method === 'HEAD' ? undefined : content);
    } catch (error) { if (!res.headersSent) json(res, error instanceof AppError ? error.status : 500, { error: error instanceof AppError ? error.message : '操作未完成，请检查服务状态' }); else res.end(); }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  return { server, engine, store, resetPassword() { const password = randomBytes(18).toString('base64url'); store.set('password', makePassword(password)); validAuth = null; return password; }, async close() { stopping = true; clearInterval(timer); await engine.stop(); await new Promise(resolve => server.listening ? server.close(resolve) : resolve()); store.close(); } };
}
