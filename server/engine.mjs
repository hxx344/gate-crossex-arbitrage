import { randomUUID, createHash } from 'node:crypto';
import { AppError, configuration, validateFeed, validSignal, pairKey, quoteKey, freshQuote, quoteTime, catalogRule, commonQuantity, validateBooks, fill, pnl } from './model.mjs';
import { loadCatalog, loadFeed, loadDepth } from './clients.mjs';

const safeMessage = error => error instanceof AppError ? error.message : '读取来源失败，请检查服务连接后重试';
export function createEngine(store, { catalogReader = loadCatalog, feedReader = loadFeed, depthReader = loadDepth, clock = Date.now } = {}) {
  let feed = null, sourceError = '等待首次读取价差服务', sourceCheckedAt = null, catalogError = null;
  let catalog = store.get('catalog', { at: 0, items: [] }), catalogAttempt = 0, chain = Promise.resolve(), closing = false;
  const recentSignals = new Map();
  // All actions and scheduler ticks share one queue; limits and dedup are checked inside it.
  const serial = action => { const result = chain.then(() => { if (closing) throw new AppError('服务正在关闭', 503); return action(); }); chain = result.catch(() => {}); return result; };
  const config = () => store.config();
  function catalogAvailable() { return Array.isArray(catalog.items) && catalog.items.length > 0 && catalog.at <= clock() + 1000 && clock() - catalog.at <= 900000; }
  async function refreshCatalog() {
    if (clock() - catalog.at < 300000 && catalogAvailable()) return;
    if (catalogAttempt && clock() - catalogAttempt < 30000) return;
    catalogAttempt = clock();
    try { const items = await catalogReader(); if (!Array.isArray(items) || !items.length || items.length > 50000) throw new AppError('CrossEx 合约目录无效'); catalog = { at: clock(), items }; store.set('catalog', catalog); catalogError = null; }
    catch (error) { catalogError = safeMessage(error); }
  }
  async function refreshFeed() {
    sourceCheckedAt = clock();
    try {
      const next = await feedReader(config(), store.decrypt(store.get('monitorPassword'))); feed = validateFeed(next, clock()); sourceError = null;
      for (const [id, signal] of recentSignals) if (!Number.isFinite(signal.expiresAt) || signal.expiresAt < clock()) recentSignals.delete(id);
      for (const signal of feed.signals) if (validSignal(signal, feed, clock())) recentSignals.set(signal.id, signal);
      while (recentSignals.size > 800) recentSignals.delete(recentSignals.keys().next().value);
    }
    catch (error) { sourceError = safeMessage(error); }
  }
  function sourceLive() { return !sourceError && feed && clock() - feed.generatedAt <= 10000 && feed.generatedAt <= clock() + 1000; }
  function candidates(signals = feed?.signals || []) {
    if (!feed) return [];
    const c = config();
    return signals.slice(0, 200).map(signal => {
      const grossBps = (signal.short?.bid / signal.long?.ask - 1) * 10000;
      const netBps = grossBps - 4 * (c.feeBps + c.slippageBps);
      let reason = '';
      if (!sourceLive()) reason = sourceError || '价差信号已经过期';
      else if (!validSignal(signal, feed, clock())) reason = '报价过期、身份不明、下架或双腿不同步';
      else if (!catalogAvailable()) reason = '等待有效的 CrossEx 合约目录';
      else { try { catalogRule(signal.long, catalog.items); catalogRule(signal.short, catalog.items); } catch (error) { reason = safeMessage(error); } }
      if (!reason && netBps < c.minNetBps) reason = '扣除往返费用与滑点预算后未达开仓阈值';
      return { ...signal, grossBps: Number.isFinite(grossBps) ? grossBps : null, netBps: Number.isFinite(netBps) ? netBps : null, eligible: !reason, reason };
    }).sort((a, b) => (b.netBps ?? -Infinity) - (a.netBps ?? -Infinity));
  }
  function valuation(p) {
    if (p.status === 'closed') return { at: p.closedAt, stale: false, ...p.result };
    const quotes = new Map((feed?.quotes || []).map(q => [quoteKey(q), q]));
    const long = quotes.get(quoteKey(p.long)), short = quotes.get(quoteKey(p.short));
    if (!sourceLive() || !freshQuote(long, clock()) || !freshQuote(short, clock()) || Math.abs(quoteTime(long) - quoteTime(short)) > 5000 || ![long, short].every(q => feed.exchanges.some(x => x.id === q.exchange && x.status === 'live'))) return { ...(p.lastValuation || { at: null, net: null }), stale: true };
    return { at: Math.min(quoteTime(long), quoteTime(short)), stale: false, ...pnl(p, long.bid, short.ask) };
  }
  function totals(positions) {
    const open = positions.filter(p => p.status === 'open');
    const marks = open.map(valuation);
    return { openCount: open.length, ...store.closedTotals(), usedNotional: open.reduce((n, p) => n + p.longFill.notional + p.shortFill.notional, 0), unrealizedPnl: marks.some(x => x.stale || x.net === null) ? null : marks.reduce((n, p) => n + p.net, 0), stalePositions: marks.filter(x => x.stale).length };
  }
  function view() {
    const positions = [...store.positions('open'), ...store.positions('closed', 200)], publicConfig = { ...config(), hasMonitorPassword: !!store.get('monitorPassword') };
    const sourceTimes = (feed?.quotes || []).map(quoteTime).filter(at => Number.isFinite(at) && at > 0 && at <= clock() + 1000);
    return { mode: 'paper', liveTradingAvailable: false, now: clock(), config: publicConfig, source: { state: sourceLive() ? feed.status : sourceError ? 'offline' : 'stale', error: sourceError, checkedAt: sourceCheckedAt, updatedAt: sourceTimes.length ? Math.max(...sourceTimes) : null, quoteCount: feed?.quotes.length || 0 }, catalog: { state: catalogAvailable() ? catalogError ? 'cached' : 'live' : 'unavailable', updatedAt: catalog.at || null, count: catalog.items.length, error: catalogError }, totals: totals(positions), opportunities: candidates(), positions: positions.filter(p => p.status === 'open').map(p => ({ ...p, valuation: valuation(p) })), history: positions.filter(p => p.status === 'closed').slice(0, 200), events: store.db.prepare('SELECT at,message FROM events ORDER BY id DESC LIMIT 100').all() };
  }
  function requestResult(requestId, fingerprint) {
    if (typeof requestId !== 'string' || !/^[a-zA-Z0-9:_-]{8,160}$/.test(requestId)) throw new AppError('缺少有效的请求编号');
    const row = store.db.prepare('SELECT * FROM requests WHERE id=?').get(requestId);
    if (row && row.fingerprint !== fingerprint) throw new AppError('请求编号已用于其他操作', 409);
    return row ? JSON.parse(row.result) : null;
  }
  const saveResult = (id, fingerprint, result) => store.db.prepare('INSERT INTO requests VALUES (?,?,?)').run(id, fingerprint, JSON.stringify(result));
  async function open(signalId, requestId) {
    const fingerprint = `open:${signalId}`, previous = requestResult(requestId, fingerprint); if (previous) return previous;
    const c = config(), remembered = recentSignals.get(signalId);
    // A browser and the collector need not poll in phase. Keep the exact server-seen
    // quote version only until its original expiry, then recheck current depth.
    const stillListed = remembered && [remembered.long, remembered.short].every(q => feed?.quotes.some(current => quoteKey(current) === quoteKey(q) && current.base === q.base && current.identityVerified === true && !current.delisting && !current.delistingAt));
    const candidate = candidates().find(s => s.id === signalId) || (stillListed ? candidates([remembered])[0] : null);
    if (!candidate?.eligible) throw new AppError(candidate?.reason || '机会已变化，请刷新后重新选择');
    const active = store.positions('open'), positions = [...active, ...store.positions('closed', 200)];
    if (active.length >= c.maxOpen) throw new AppError('已达到最大持仓数量');
    if (store.hasSignal(signalId)) throw new AppError('这份信号已执行过模拟', 409);
    if (active.some(p => p.base === candidate.base)) throw new AppError('该币种已有模拟持仓，不重复或反向开仓', 409);
    if (store.coolingBases(clock() - c.cooldownSeconds * 1000).includes(candidate.base)) throw new AppError('该币种仍在开仓冷却期');
    const rules = [catalogRule(candidate.long, catalog.items), catalogRule(candidate.short, catalog.items)];
    const books = await Promise.all([depthReader(candidate.long), depthReader(candidate.short)]);
    if (!sourceLive() || !validSignal(candidate, feed, clock()) || !catalogAvailable()) throw new AppError('深度检查期间信号过期，请等待新机会');
    validateBooks(books, clock());
    const quantity = commonQuantity(c.notionalPerLeg, [books[0].asks[0][0], books[1].bids[0][0]], rules);
    const longFill = fill(books[0].asks, quantity, 'buy', c.slippageBps), shortFill = fill(books[1].bids, quantity, 'sell', c.slippageBps);
    if (Math.max(longFill.notional, shortFill.notional) > c.notionalPerLeg + 1e-8) throw new AppError('逐档成交名义额超过单腿额度');
    if ((shortFill.price / longFill.price - 1) * 10000 - 4 * c.feeBps - 2 * c.slippageBps < c.minNetBps) throw new AppError('重新检查深度后净价差不足');
    if (totals(positions).usedNotional + longFill.notional + shortFill.notional > c.maxTotalNotional) throw new AppError('已达到双腿总名义额上限');
    const p = { id: randomUUID(), signalId, pairKey: pairKey(candidate), base: candidate.base, status: 'open', openedAt: clock(), quantity, long: candidate.long, short: candidate.short, crossexSymbols: rules.map(x => x.symbol), longFill, shortFill, depthAt: books.map(x => x.at), feeBps: c.feeBps, slippageBps: c.slippageBps, takeProfitBps: c.takeProfitBps, stopLossBps: c.stopLossBps, maxHoldMinutes: c.maxHoldMinutes, entryFees: (longFill.notional + shortFill.notional) * c.feeBps / 10000, entryGrossBps: (shortFill.price / longFill.price - 1) * 10000, fundingPnl: null };
    store.transaction(() => { store.savePosition(p); saveResult(requestId, fingerprint, p); store.event(clock(), `${p.base} 已模拟开仓，双腿各 ${quantity}；按可见深度全量撮合`); });
    return p;
  }
  async function closePosition(id, requestId, reason = '手动平仓') {
    const fingerprint = `close:${id}`, previous = requestResult(requestId, fingerprint); if (previous) return previous;
    const p = store.findPosition(id);
    if (!p || p.status !== 'open') throw new AppError('持仓不存在或已经平仓', 409);
    const books = await Promise.all([depthReader(p.long), depthReader(p.short)]); validateBooks(books, clock());
    const longExit = fill(books[0].bids, p.quantity, 'sell', p.slippageBps), shortExit = fill(books[1].asks, p.quantity, 'buy', p.slippageBps);
    const result = pnl(p, longExit.price, shortExit.price);
    // Profit-triggered exits are rechecked after fetching independent depth snapshots.
    if (reason === '达到止盈' && result.net / p.longFill.notional * 10000 < p.takeProfitBps) throw new AppError('深度复核后尚未达到止盈，继续持有');
    const closed = { ...p, status: 'closed', closedAt: clock(), reason, longExit, shortExit, exitDepthAt: books.map(x => x.at), result };
    store.transaction(() => { store.savePosition(closed); saveResult(requestId, fingerprint, closed); store.event(clock(), `${p.base} ${reason}，模拟净盈亏 ${result.net.toFixed(4)} USDT（未含资金费）`); });
    return closed;
  }
  async function tick() {
    await Promise.all([refreshCatalog(), refreshFeed()]);
    const positions = store.positions('open');
    for (const p of positions) {
      const value = valuation(p);
      if (!value.stale) store.savePosition({ ...p, lastValuation: value });
      if (!config().enabled || value.stale) continue;
      const bps = value.net / p.longFill.notional * 10000;
      const reason = bps >= p.takeProfitBps ? '达到止盈' : bps <= -p.stopLossBps ? '达到止损' : clock() - p.openedAt >= p.maxHoldMinutes * 60000 ? '达到最长持有时间' : '';
      if (reason) { try { await closePosition(p.id, `auto-close:${p.id}`, reason); } catch (error) { recordFailure(`${p.base} 自动平仓未完成：${safeMessage(error)}`); } }
    }
    if (config().enabled) {
      const active = store.positions('open');
      const busyBases = new Set([...active.map(p => p.base), ...store.coolingBases(clock() - config().cooldownSeconds * 1000)]);
      for (const [key, until] of retryAfter) if (until <= clock()) retryAfter.delete(key);
      const candidate = active.length < config().maxOpen ? candidates().find(s => s.eligible && !busyBases.has(s.base) && !store.hasSignal(s.id) && !retryAfter.has(s.pairKey)) : null;
      if (candidate) { try { await open(candidate.id, `auto-open:${createHash('sha256').update(candidate.id).digest('hex')}`); } catch (error) { retryAfter.set(candidate.pairKey, clock() + 30000); recordFailure(`${candidate.base} 自动开仓未完成：${safeMessage(error)}`); } }
    }
    return view();
  }
  const retryAfter = new Map();
  let lastFailure = '', lastFailureAt = 0;
  function recordFailure(message) { if (message !== lastFailure || clock() - lastFailureAt > 60000) { store.event(clock(), message); lastFailure = message; lastFailureAt = clock(); } }
  function settings(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['config', 'monitorPassword', 'clearMonitorPassword'].includes(k))) throw new AppError('设置格式无效');
    const previous = config(), next = configuration(input.config, previous);
    if (input.monitorPassword !== undefined && (typeof input.monitorPassword !== 'string' || input.monitorPassword.length > 1024)) throw new AppError('价差服务密码过长');
    if (input.clearMonitorPassword !== undefined && typeof input.clearMonitorPassword !== 'boolean') throw new AppError('清除密码选项无效');
    const changed = previous.monitorUrl !== next.monitorUrl || previous.monitorUsername !== next.monitorUsername;
    store.transaction(() => { store.set('config', next); if (changed || input.clearMonitorPassword) store.set('monitorPassword', null); if (input.monitorPassword) store.set('monitorPassword', store.encrypt(input.monitorPassword)); store.event(clock(), next.enabled ? '已开启自动模拟；配置已保存' : '自动模拟已暂停；配置已保存'); });
    if (changed || input.clearMonitorPassword || input.monitorPassword) { feed = null; recentSignals.clear(); sourceError = '连接设置已更改，等待重新读取'; }
    return view();
  }
  return { view, tick: () => serial(tick), open: (s, r) => serial(() => open(s, r)), closePosition: (id, r) => serial(() => closePosition(id, r)), settings: input => serial(() => settings(input)), async stop() { closing = true; await chain; } };
}
