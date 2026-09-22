import { randomUUID, createHash } from 'node:crypto';
import { AppError, configuration, validateFeed, validSignal, pairKey, quoteKey, contractIdentity, freshQuote, quoteTime, catalogRule, commonQuantity, validateBooks, fill, pnl, fxRate, referencePrice, notionalUSDT, storedNotional, settlement, SUPPORTED_VENUES } from './model.mjs';
import { loadCatalog, loadFeed, loadDepth, loadFx } from './clients.mjs';

const safeMessage = error => error instanceof AppError ? error.message : '读取来源失败，请检查服务连接后重试';
export function createEngine(store, { catalogReader = loadCatalog, feedReader = loadFeed, depthReader = loadDepth, fxReader = loadFx, clock = Date.now } = {}) {
  let feed = null, sourceError = '等待首次读取价差服务', sourceCheckedAt = null, catalogError = null;
  let sourceReceivedAt = null, sourceDurationMs = null;
  let catalog = store.get('catalog', { at: 0, items: [] }), catalogAttempt = 0, chain = Promise.resolve(), closing = false;
  let sourceFlight = null, sourceGeneration = 0;
  const recentSignals = new Map();
  let indexedFeed = null, quoteIndex = new Map(), venueCounts = new Map(), cachedHistory = null;
  const historyEpoch = randomUUID();
  function indexFeed() {
    if (indexedFeed === feed) return;
    indexedFeed = feed; quoteIndex = new Map(); venueCounts = new Map();
    for (const q of feed?.quotes || []) { quoteIndex.set(quoteKey(q), q); venueCounts.set(q.exchange, (venueCounts.get(q.exchange) || 0) + 1); }
  }
  function historyView(knownVersion) {
    const eventId = store.db.prepare('SELECT coalesce(max(id),0) AS id FROM events').get().id;
    const closed = store.db.prepare("SELECT count(*) AS count,max(json_extract(json,'$.closedAt')) AS at FROM positions WHERE status='closed'").get();
    const version = [historyEpoch, eventId, closed.count, closed.at || 0].join(':');
    if (version === knownVersion) return { historyVersion: version };
    if (cachedHistory?.historyVersion !== version) cachedHistory = { historyVersion: version, history: store.positions('closed', 200), events: store.db.prepare('SELECT at,message FROM events ORDER BY id DESC LIMIT 100').all() };
    return cachedHistory;
  }
  // Simulation actions remain serialized; read-only source refreshes have their own lane.
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
  async function refreshFeed(generation) {
    const startedAt = clock(); sourceCheckedAt = startedAt;
    try {
      const next = await feedReader(config(), store.decrypt(store.get('monitorPassword')));
      if (closing || generation !== sourceGeneration) return;
      feed = validateFeed(next, clock()); sourceError = null; sourceReceivedAt = clock();
      for (const [id, signal] of recentSignals) if (!Number.isFinite(signal.expiresAt) || signal.expiresAt < clock()) recentSignals.delete(id);
      for (const signal of feed.signals) if (validSignal(signal, feed, clock())) recentSignals.set(signal.id, signal);
      while (recentSignals.size > 800) recentSignals.delete(recentSignals.keys().next().value);
    }
    catch (error) { if (!closing && generation === sourceGeneration) sourceError = safeMessage(error); }
    finally { if (!closing && generation === sourceGeneration) sourceDurationMs = Math.max(0, clock() - startedAt); }
  }
  function refreshSource() {
    if (closing) return Promise.resolve();
    // Slow reads are shared, never queued. A settings change invalidates both
    // successful and failed responses from the previous connection.
    if (!sourceFlight) sourceFlight = refreshFeed(sourceGeneration).finally(() => { sourceFlight = null; });
    return sourceFlight;
  }
  function sourceLive() { return !sourceError && feed && clock() - feed.generatedAt <= 10000 && feed.generatedAt <= clock() + 1000; }
  function candidates(signals = feed?.signals || []) {
    if (!feed) return [];
    const c = config();
    return signals.slice(0, 200).map(signal => {
      let grossBps = NaN, reason = '', warnings = [];
      try { grossBps = (referencePrice(signal.short, signal.short.bid, 'sell', feed.fx, clock()) / referencePrice(signal.long, signal.long.ask, 'buy', feed.fx, clock()) - 1) * 10000; for (const q of [signal.long, signal.short]) fxRate(settlement(q), feed.fx, clock()); } catch (error) { reason = safeMessage(error); }
      const netBps = grossBps - 4 * (c.feeBps + c.slippageBps);
      if (!sourceLive()) reason = sourceError || '价差信号已经过期';
      else if (!reason && !validSignal(signal, feed, clock())) reason = '报价过期、身份不明、下架或双腿不同步';
      else if (!catalogAvailable()) reason = '等待有效的 CrossEx 合约目录';
      else if (!reason) { try { warnings = [catalogRule(signal.long, catalog.items), catalogRule(signal.short, catalog.items)].flatMap(rule => rule.unverifiedConstraints); } catch (error) { reason = safeMessage(error); } }
      if (!reason && netBps < c.minNetBps) reason = '扣除往返费用与滑点预算后未达开仓阈值';
      return { ...signal, grossBps: Number.isFinite(grossBps) ? grossBps : null, netBps: Number.isFinite(netBps) ? netBps : null, eligible: !reason, reason, warnings };
    }).sort((a, b) => (b.netBps ?? -Infinity) - (a.netBps ?? -Infinity));
  }
  function valuation(p) {
    if (p.status === 'closed') return { at: p.closedAt, stale: false, ...p.result };
    indexFeed();
    const long = quoteIndex.get(quoteKey(p.long)), short = quoteIndex.get(quoteKey(p.short));
    const quoteTimes = { long: Number.isFinite(quoteTime(long)) ? quoteTime(long) : null, short: Number.isFinite(quoteTime(short)) ? quoteTime(short) : null };
    const old = reason => ({ ...(p.lastValuation || { at: null, net: null }), stale: true, reason, quoteTimes });
    if (!sourceLive()) return old(sourceError || '价差数据包超过 10 秒，等待来源更新');
    for (const [q, leg] of [[long, p.long], [short, p.short]]) {
      if (!q) return old(`${leg.exchange} 缺少该合约盘口`);
      if (contractIdentity(q) !== contractIdentity(leg)) return old(`${leg.exchange} 合约身份已变化`);
      if (!freshQuote(q, clock())) {
        const at = quoteTime(q);
        if (Number.isFinite(at) && at > 0 && clock() - at > 10000) return old(`${leg.exchange} 盘口已 ${((clock() - at) / 1000).toFixed(1)} 秒未更新`);
        if (at > clock() + 1000) return old(`${leg.exchange} 盘口时间领先服务器超过 1 秒`);
        return old(`${leg.exchange} 盘口价格、时间或合约身份无效`);
      }
      if (!feed.exchanges.some(x => x.id === q.exchange && x.status === 'live')) return old(`${leg.exchange} 行情连接未就绪`);
    }
    const gap = Math.abs(quoteTime(long) - quoteTime(short));
    if (gap > 5000) return old(`双腿盘口相差 ${(gap / 1000).toFixed(1)} 秒，超过 5 秒同步要求`);
    try { return { at: Math.min(quoteTime(long), quoteTime(short)), stale: false, quoteTimes, ...pnl(p, long.bid, short.ask, feed.fx, clock()) }; } catch (error) { return old(safeMessage(error)); }
  }
  function totals(positions, marks = null) {
    const open = positions.filter(p => p.status === 'open');
    marks ??= open.map(valuation);
    return { openCount: open.length, ...store.closedTotals(), usedNotional: open.reduce((n, p) => n + storedNotional(p.longFill) + storedNotional(p.shortFill), 0), unrealizedPnl: marks.some(x => x.stale || x.net === null) ? null : marks.reduce((n, p) => n + p.net, 0), stalePositions: marks.filter(x => x.stale).length };
  }
  function view({ includeHistory = true, historyVersion } = {}) {
    indexFeed();
    const positions = store.positions('open'), publicConfig = { ...config(), hasMonitorPassword: !!store.get('monitorPassword') };
    const sourceTimes = (feed?.quotes || []).map(quoteTime).filter(at => Number.isFinite(at) && at > 0 && at <= clock() + 1000);
    const hasFreshSource = (feed?.quotes || []).some(q => freshQuote(q, clock()) && feed.exchanges.some(x => x.id === q.exchange && x.status === 'live'));
    const venues = SUPPORTED_VENUES.map(id => { const upstream = feed?.exchanges.find(x => x.id === id); return { id, state: sourceLive() ? upstream?.status ?? 'unavailable' : 'offline', quoteCount: venueCounts.get(id) || 0 }; });
    const fx = ['USDC', 'USD'].map(currency => { try { return { currency, state: 'live', ...fxRate(currency, feed?.fx, clock()) }; } catch (error) { return { currency, state: 'unavailable', error: safeMessage(error) }; } });
    return { mode: 'paper', liveTradingAvailable: false, now: clock(), venues, fx, config: publicConfig, source: { state: sourceLive() && hasFreshSource ? feed.status : sourceError ? 'offline' : 'stale', error: sourceError, checkedAt: sourceCheckedAt, receivedAt: sourceReceivedAt, durationMs: sourceDurationMs, generatedAt: feed?.generatedAt ?? null, updatedAt: sourceTimes.length ? Math.max(...sourceTimes) : null, quoteCount: feed?.quotes.length || 0 }, catalog: { state: catalogAvailable() ? catalogError ? 'cached' : 'live' : 'unavailable', updatedAt: catalog.at || null, count: catalog.items.length, error: catalogError }, totals: totals(positions), opportunities: candidates(), positions: positions.filter(p => p.status === 'open').map(p => ({ ...p, valuation: valuation(p) })), ...(includeHistory ? historyView(historyVersion) : {}) };
  }
  // Read only the open positions and aggregate totals; no candidate ranking or history payload.
  function summary() {
    indexFeed();
    const now = clock(), positions = store.positions('open'), marks = positions.map(valuation), value = totals(positions, marks), messages = [];
    const liveVenues = new Set(feed?.exchanges.filter(x => x.status === 'live').map(x => x.id));
    let oldest = Infinity, latestFresh = -Infinity, fresh = 0, expired = 0;
    for (const q of quoteIndex.values()) {
      const at = quoteTime(q);
      if (Number.isFinite(at) && at > 0 && at <= now + 1000) oldest = Math.min(oldest, at);
      if (freshQuote(q, now) && liveVenues.has(q.exchange)) { fresh++; latestFresh = Math.max(latestFresh, at); }
      else expired++;
    }
    let state = !feed || sourceError ? 'offline' : !sourceLive() || !fresh ? 'stale' : 'online';
    let updatedAt = oldest;
    if (state === 'online') {
      // A partial feed is still active while usable quotes arrive. Neither a
      // request heartbeat nor a newer unrelated quote may freshen held PnL.
      updatedAt = Math.min(feed.generatedAt, latestFresh);
      if (value.unrealizedPnl !== null) for (const mark of marks) updatedAt = Math.min(updatedAt, mark.at);
    }
    if (sourceError) messages.push(sourceError);
    if (expired) messages.push(expired + ' 条盘口过期、无效或交易所未连接');
    const unavailable = feed?.exchanges.filter(x => x.status !== 'live').map(x => x.id) || [];
    if (unavailable.length) messages.push('行情异常：' + unavailable.join('、'));
    if (feed?.status !== 'live' && feed) messages.push('行情源状态：' + feed.status);
    if (!catalogAvailable() || catalogError) messages.push(catalogError || 'CrossEx 合约目录未就绪或已过期');
    if (value.stalePositions) messages.push(value.stalePositions + ' 组持仓估值过期');
    if (state === 'online' && messages.length) state = 'partial';
    return { updatedAt: Number.isFinite(updatedAt) ? new Date(updatedAt).toISOString() : null,
      health: { state, message: messages.join('；') || '行情与合约目录正常', staleAfterSeconds: 10 }, metrics: [
        { key: 'mode', label: '执行模式', value: config().enabled ? '自动模拟' : '模拟已暂停', detail: '仅本地模拟，不发送交易所订单' },
        { key: 'source', label: '价差信号', value: state, detail: messages.join('；') || '七所同币种永续，按实际汇率折算 USDT' },
        { key: 'positions', label: '模拟持仓', value: value.openCount, unit: '组' },
        { key: 'realized', label: '模拟已实现盈亏', value: value.realizedPnl, unit: 'USDT', detail: '已扣手续费，未含资金费；不计入资产账本' },
        { key: 'unrealized', label: '模拟浮动盈亏', value: value.unrealizedPnl, unit: 'USDT', detail: '按平仓方向盘口估值；过期时不汇总' },
        { key: 'catalog', label: 'CrossEx 目录', value: catalogAvailable() ? catalogError ? 'cached' : 'live' : 'unavailable' },
      ] };
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
    const stillListed = remembered && [remembered.long, remembered.short].every(q => feed?.quotes.some(current => contractIdentity(current) === contractIdentity(q) && current.identityVerified === true && !current.delisting && !current.delistingAt));
    const candidate = candidates().find(s => s.id === signalId) || (stillListed ? candidates([remembered])[0] : null);
    if (!candidate?.eligible) throw new AppError(candidate?.reason || '机会已变化，请刷新后重新选择');
    const active = store.positions('open'), positions = [...active, ...store.positions('closed', 200)];
    if (active.length >= c.maxOpen) throw new AppError('已达到最大持仓数量');
    if (store.hasSignal(signalId)) throw new AppError('这份信号已执行过模拟', 409);
    if (active.some(p => p.base === candidate.base)) throw new AppError('该币种已有模拟持仓，不重复或反向开仓', 409);
    if (store.coolingBases(clock() - c.cooldownSeconds * 1000).includes(candidate.base)) throw new AppError('该币种仍在开仓冷却期');
    const rules = [catalogRule(candidate.long, catalog.items), catalogRule(candidate.short, catalog.items)];
    const legs = [candidate.long, candidate.short];
    const [books, fx] = await Promise.all([Promise.all(legs.map(q => depthReader(q))), legs.every(q => q.quoteCurrency === 'USDT' && settlement(q) === 'USDT') ? null : fxReader()]);
    if (!sourceLive() || !validSignal(candidate, feed, clock()) || !catalogAvailable()) throw new AppError('深度检查期间信号过期，请等待新机会');
    validateBooks(books, clock());
    const prices = [books[0].asks[0][0], books[1].bids[0][0]];
    const quantity = commonQuantity(c.notionalPerLeg, prices, rules, legs.map((q, i) => notionalUSDT(q, prices[i], fx, clock())));
    const longFill = fill(books[0].asks, quantity, 'buy', c.slippageBps), shortFill = fill(books[1].bids, quantity, 'sell', c.slippageBps);
    for (const [i, filled] of [longFill, shortFill].entries()) { filled.notionalUSDT = notionalUSDT(legs[i], filled.notional, fx, clock()); if (rules[i].min_notional !== null && filled.notional < Number(rules[i].min_notional)) throw new AppError('逐档成交未满足最小名义额'); }
    if (Math.max(longFill.notionalUSDT, shortFill.notionalUSDT) > c.notionalPerLeg + 1e-8) throw new AppError('逐档成交名义额超过单腿额度');
    const entryGrossBps = (referencePrice(candidate.short, shortFill.price, 'sell', fx, clock()) / referencePrice(candidate.long, longFill.price, 'buy', fx, clock()) - 1) * 10000;
    if (entryGrossBps - 4 * c.feeBps - 2 * c.slippageBps < c.minNetBps) throw new AppError('重新检查深度后净价差不足');
    if (totals(positions).usedNotional + longFill.notionalUSDT + shortFill.notionalUSDT > c.maxTotalNotional) throw new AppError('已达到双腿总名义额上限');
    const p = { accountingVersion: 2, id: randomUUID(), signalId, pairKey: pairKey(candidate), base: candidate.base, status: 'open', openedAt: clock(), quantity, long: candidate.long, short: candidate.short, crossexSymbols: rules.map(x => x.symbol), unverifiedConstraints: rules.flatMap(r => r.unverifiedConstraints), longFill, shortFill, entryFx: fx, depthAt: books.map(x => x.at), feeBps: c.feeBps, slippageBps: c.slippageBps, takeProfitBps: c.takeProfitBps, stopLossBps: c.stopLossBps, maxHoldMinutes: c.maxHoldMinutes, entryFees: (longFill.notionalUSDT + shortFill.notionalUSDT) * c.feeBps / 10000, entryGrossBps, fundingPnl: null };
    store.transaction(() => { store.savePosition(p); saveResult(requestId, fingerprint, p); store.event(clock(), `${p.base} 已模拟开仓，双腿各 ${quantity}；按可见深度全量撮合`); });
    return p;
  }
  function checkPositionIdentity(p) {
    for (const q of [p.long, p.short]) { const current = feed?.quotes.find(x => quoteKey(x) === quoteKey(q)); if (current && contractIdentity(current) !== contractIdentity(q)) throw new AppError('合约身份或结算规则发生变化，暂停此持仓操作'); }
  }
  async function closePosition(id, requestId, reason = '手动平仓') {
    const fingerprint = `close:${id}`, previous = requestResult(requestId, fingerprint); if (previous) return previous;
    const p = store.findPosition(id);
    if (!p || p.status !== 'open') throw new AppError('持仓不存在或已经平仓', 409);
    checkPositionIdentity(p);
    const [books, fx] = await Promise.all([Promise.all([depthReader(p.long), depthReader(p.short)]), [p.long, p.short].every(q => settlement(q) === 'USDT') ? null : fxReader()]);
    checkPositionIdentity(p);
    validateBooks(books, clock());
    const longExit = fill(books[0].bids, p.quantity, 'sell', p.slippageBps), shortExit = fill(books[1].asks, p.quantity, 'buy', p.slippageBps);
    const result = pnl(p, longExit.price, shortExit.price, fx, clock());
    // Profit-triggered exits are rechecked after fetching independent depth snapshots.
    if (reason === '达到止盈' && result.net / storedNotional(p.longFill) * 10000 < p.takeProfitBps) throw new AppError('深度复核后尚未达到止盈，继续持有');
    const closed = { ...p, status: 'closed', closedAt: clock(), reason, longExit, shortExit, exitFx: fx, exitDepthAt: books.map(x => x.at), result };
    store.transaction(() => { store.savePosition(closed); saveResult(requestId, fingerprint, closed); store.event(clock(), `${p.base} ${reason}，模拟净盈亏 ${result.net.toFixed(4)} USDT（未含资金费）`); });
    return closed;
  }
  async function tick({ refreshSource: readSource = true } = {}) {
    await Promise.all([refreshCatalog(), readSource ? refreshSource() : undefined]);
    const positions = store.positions('open');
    for (const p of positions) {
      const value = valuation(p);
      if (!value.stale) store.savePosition({ ...p, lastValuation: value });
      if (!config().enabled || value.stale) continue;
      const bps = value.net / storedNotional(p.longFill) * 10000;
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
    if (changed || input.clearMonitorPassword || input.monitorPassword) { sourceGeneration++; feed = null; recentSignals.clear(); sourceCheckedAt = null; sourceReceivedAt = null; sourceDurationMs = null; sourceError = '连接设置已更改，等待重新读取'; }
    return view();
  }
  return { view, summary, refreshSource, tick: options => serial(() => tick(options)), open: (s, r) => serial(() => open(s, r)), closePosition: (id, r) => serial(() => closePosition(id, r)), settings: input => serial(() => settings(input)), async stop() { closing = true; await Promise.all([chain, sourceFlight]); } };
}
