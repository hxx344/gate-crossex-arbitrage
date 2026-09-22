export class AppError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
export const defaults = Object.freeze({ enabled: false, monitorUrl: 'http://127.0.0.1:3000', monitorUsername: 'admin', notionalPerLeg: 100, maxOpen: 3, maxTotalNotional: 1000, feeBps: 6, slippageBps: 5, minNetBps: 20, takeProfitBps: 10, stopLossBps: 100, maxHoldMinutes: 60, cooldownSeconds: 60 });
export const positive = n => typeof n === 'number' && Number.isFinite(n) && n > 0;
export function monitorUrl(value) {
  let url; try { url = new URL(value); } catch { throw new AppError('价差服务地址无效'); }
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new AppError('价差服务须为同机 localhost / 127.0.0.1 / [::1] 地址，不含路径或凭据');
  return url.origin;
}
export function configuration(input, previous = defaults) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !Object.hasOwn(defaults, key))) throw new AppError('配置字段无效');
  const result = { ...previous, ...input };
  if (typeof result.enabled !== 'boolean') throw new AppError('自动模拟开关无效');
  result.monitorUrl = monitorUrl(result.monitorUrl);
  if (typeof result.monitorUsername !== 'string' || result.monitorUsername.length > 100 || /[:\r\n]/.test(result.monitorUsername)) throw new AppError('价差服务用户名无效');
  const bounds = { notionalPerLeg: [5, 100000], maxOpen: [1, 20], maxTotalNotional: [10, 2000000], feeBps: [0, 100], slippageBps: [0, 100], minNetBps: [0, 5000], takeProfitBps: [1, 5000], stopLossBps: [1, 10000], maxHoldMinutes: [1, 10080], cooldownSeconds: [10, 86400] };
  for (const [key, [min, max]] of Object.entries(bounds)) if (typeof result[key] !== 'number' || !Number.isFinite(result[key]) || result[key] < min || result[key] > max) throw new AppError(`${key} 应为 ${min}–${max}`);
  if (!Number.isInteger(result.maxOpen) || result.maxTotalNotional < result.notionalPerLeg * 2) throw new AppError('持仓数量须为整数，总双腿额度不得低于单腿额度的两倍');
  return result;
}
export const quoteKey = q => `${q.exchange}:${q.symbol}`;
export const pairKey = s => JSON.stringify([s.base, quoteKey(s.long), quoteKey(s.short)]);
export const SUPPORTED_VENUES = Object.freeze(['binance', 'bybit', 'okx', 'gate', 'kraken', 'hyperliquid', 'lighter']);
export const settlement = q => q?.settlementCurrency ?? q?.quoteCurrency ?? 'USDT';
export function contractIdentity(q) {
  return JSON.stringify([q.exchange, q.symbol, q.base, q.rawBase ?? q.base, q.quoteCurrency, settlement(q), q.collateralCurrency, q.multiplier, q.contractKind ?? 'linear', q.counterCurrency ?? q.quoteCurrency, q.crossexSymbol ?? `${q.exchange.toUpperCase()}_FUTURE_${q.base}_${q.quoteCurrency}`, q.marketId ?? null]);
}
export function validIdentity(q) {
  if (!q || !SUPPORTED_VENUES.includes(q.exchange) || !/^[A-Z0-9]{1,30}$/.test(q.base) || (q.rawBase !== undefined && q.rawBase !== q.base) || q.multiplier !== 1 || q.assetClass !== 'crypto' || q.identityVerified !== true || typeof q.identitySource !== 'string' || !q.identitySource || q.comparable === false) return false;
  const currency = q.quoteCurrency, base = q.base;
  let symbol, counter = currency, settle = currency, collateral = currency, kind = 'linear';
  if (['binance', 'bybit', 'okx'].includes(q.exchange)) {
    if (!['USDT', 'USDC'].includes(currency)) return false;
    symbol = q.exchange === 'okx' ? `${base}-${currency}-SWAP` : q.exchange === 'bybit' && currency === 'USDC' ? `${base}PERP` : `${base}${currency}`;
  } else if (q.exchange === 'gate') { if (currency !== 'USDT' || base === 'EDGE') return false; symbol = `${base}_USDT`; }
  else if (q.exchange === 'kraken') { if (currency !== 'USD') return false; symbol = `PF_${base === 'BTC' ? 'XBT' : base}USD`; collateral = 'MULTI'; }
  else if (q.exchange === 'hyperliquid') { if (currency !== (['HYPE', 'PURR'].includes(base) ? 'USDC' : 'USDT')) return false; symbol = base; settle = collateral = counter = 'USDC'; kind = currency === 'USDC' ? 'linear' : 'quanto'; }
  else { if (currency !== 'USDC' || base === 'AI' || !Number.isInteger(q.marketId) || q.marketId < 0) return false; symbol = base; }
  const legacy = ['binance', 'bybit'].includes(q.exchange) && currency === 'USDT' && q.settlementCurrency === undefined && q.contractKind === undefined && q.crossexSymbol === undefined;
  return q.symbol === symbol && q.collateralCurrency === collateral && (legacy || (q.settlementCurrency === settle && q.contractKind === kind && q.counterCurrency === counter && q.crossexSymbol === `${q.exchange.toUpperCase()}_FUTURE_${base}_${counter}`));
}
export function fxRate(currency, fx, now) {
  if (currency === 'USDT') return { bid: 1, ask: 1, at: now, source: 'USDT 计价基准' };
  const rate = fx?.baseCurrency === 'USDT' && Object.hasOwn(fx.rates || {}, currency) ? fx.rates[currency] : null;
  const age = Math.min(180000, fx?.staleAfterMs ?? 0);
  if (!['USDC', 'USD'].includes(currency) || !rate || !positive(rate.bid) || !positive(rate.ask) || rate.ask < rate.bid || !Number.isFinite(rate.at) || rate.at <= 0 || rate.at > now + 1000 || !positive(age) || now - rate.at > age || typeof rate.source !== 'string' || !rate.source) throw new AppError(`${currency} / USDT 汇率缺失或过期`);
  return rate;
}
export function convert(value, currency, fx, now) { const rate = fxRate(currency, fx, now); return value * (value >= 0 ? rate.bid : rate.ask); }
export function referencePrice(q, price, side, fx, now) { return price * fxRate(q.quoteCurrency, fx, now)[side === 'buy' ? 'ask' : 'bid']; }
export function notionalUSDT(q, amount, fx, now) { return amount * fxRate(settlement(q), fx, now).ask; }
export const storedNotional = fill => fill.notionalUSDT ?? fill.notional;
export function quoteTime(q) { return Math.min(q?.bidAskAt ?? NaN, q?.receivedAt ?? NaN); }
export function freshQuote(q, now) {
  const at = quoteTime(q);
  return validIdentity(q) && positive(q.bid) && positive(q.ask) && q.bid <= q.ask && Number.isFinite(at) && at > 0 && at <= now + 1000 && now - at <= 10000;
}
export function validSignal(s, feed, now) {
  if (!s || typeof s.id !== 'string' || s.id.length > 150 || !s.id || s.base !== s.long?.base || s.base !== s.short?.base || s.quoteCurrency !== 'USDT' || s.long?.exchange === s.short?.exchange || !freshQuote(s.long, now) || !freshQuote(s.short, now) || s.pairKey !== pairKey(s)) return false;
  if (Math.abs(quoteTime(s.long) - quoteTime(s.short)) > 5000 || !Number.isFinite(s.expiresAt) || s.expiresAt < now || s.expiresAt > Math.min(quoteTime(s.long), quoteTime(s.short)) + 10000) return false;
  try { for (const q of [s.long, s.short]) { fxRate(q.quoteCurrency, feed.fx, now); fxRate(settlement(q), feed.fx, now); } } catch { return false; }
  return [s.long, s.short].every(q => !q.delisting && !q.delistingAt && feed.exchanges.some(x => x.id === q.exchange && x.status === 'live') && feed.quotes.some(current => quoteKey(current) === quoteKey(q) && contractIdentity(current) === contractIdentity(q) && freshQuote(current, now) && !current.delisting && !current.delistingAt));
}
export function validateFeed(feed, now) {
  if (!feed || ![1, 2].includes(feed.schemaVersion) || feed.mode !== 'paper' || feed.source !== 'market-monitor' || feed.monitorId !== 'perpetual' || !Array.isArray(feed.quotes) || feed.quotes.length > 5000 || !Array.isArray(feed.signals) || feed.signals.length > 200 || !Array.isArray(feed.exchanges) || !Number.isFinite(feed.generatedAt) || feed.generatedAt > now + 1000 || now - feed.generatedAt > 10000) throw new AppError('价差信号格式不兼容或已经过期', 502);
  if (new Set(feed.quotes.map(quoteKey)).size !== feed.quotes.length) throw new AppError('价差来源包含重复合约', 502);
  if (!['live', 'partial'].includes(feed.status) || feed.storageError || feed.error) throw new AppError('价差服务没有可用的实时行情', 502);
  return feed;
}
export function catalogRule(q, catalog) {
  if (!validIdentity(q)) throw new AppError('仅支持七所身份明确、单位为 1 的普通加密永续');
  const symbol = q.crossexSymbol ?? `${q.exchange.toUpperCase()}_FUTURE_${q.base}_USDT`;
  const rule = catalog.find(x => x.symbol === symbol && x.exchange_type === q.exchange.toUpperCase() && x.business_type === 'FUTURE');
  if (!rule || rule.state !== 'live' || String(rule.delist_time ?? '') !== '0') throw new AppError(`${symbol} 未在 CrossEx 确认为可用合约`);
  for (const field of ['min_size', 'lot_size', 'tick_size']) if (!positive(Number(rule[field]))) throw new AppError(`${symbol} 缺少有效的数量或价格规则`);
  const unverifiedConstraints = [];
  for (const field of ['min_notional', 'max_market_size']) {
    if (rule[field] === null) { unverifiedConstraints.push(`${symbol}：目录未提供${field === 'min_notional' ? '最小名义额' : '最大市价数量'}`); continue; }
    if (rule[field] === undefined || String(rule[field]).trim() === '' || !Number.isFinite(Number(rule[field])) || (field === 'max_market_size' ? Number(rule[field]) <= 0 : Number(rule[field]) < 0)) throw new AppError(`${symbol} 缺少有效的${field === 'min_notional' ? '最小名义额' : '最大数量'}规则`);
  }
  return { ...rule, unverifiedConstraints };
}
const SCALE = 100000000n;
function units(value) {
  if (!/^\d+(?:\.\d{1,8})?$/.test(String(value))) throw new AppError('数量步长精度超出模拟器支持范围');
  const [a, b = ''] = String(value).split('.'); return BigInt(a) * SCALE + BigInt(b.padEnd(8, '0'));
}
function gcd(a, b) { while (b) [a, b] = [b, a % b]; return a; }
export function commonQuantity(budget, prices, rules, budgetPrices = prices) {
  const steps = rules.map(x => units(x.lot_size));
  if (!positive(budget) || [...prices, ...budgetPrices].some(n => !positive(n)) || steps.some(n => n <= 0n)) throw new AppError('额度或数量规则无效');
  const step = steps[0] / gcd(steps[0], steps[1]) * steps[1];
  const max = Math.min(budget / Math.max(...budgetPrices), ...rules.filter(x => x.max_market_size !== null).map(x => Number(x.max_market_size)));
  const quantity = Number(BigInt(Math.floor(max * Number(SCALE))) / step * step) / Number(SCALE);
  if (!positive(quantity) || rules.some((r, i) => quantity < Number(r.min_size) || (r.min_notional !== null && quantity * prices[i] < Number(r.min_notional)))) throw new AppError('额度取整后未满足双腿最小数量或最小名义额');
  return quantity;
}
export function validateBooks(books, now) {
  for (const book of books) {
    if (!Number.isFinite(book.at) || now - book.at > 10000 || book.at > now + 1000) throw new AppError('深度快照已经过期或时间异常');
    for (const side of ['bids', 'asks']) {
      if (!Array.isArray(book[side]) || !book[side].length || book[side].length > 1000) throw new AppError('深度快照缺失');
      for (const [i, level] of book[side].entries()) if (!Array.isArray(level) || !positive(level[0]) || !positive(level[1]) || (i && (side === 'bids' ? level[0] >= book[side][i - 1][0] : level[0] <= book[side][i - 1][0]))) throw new AppError('深度快照价格或排序异常');
    }
    if (book.bids[0][0] > book.asks[0][0]) throw new AppError('深度快照买卖价交叉');
  }
  if (Math.abs(books[0].at - books[1].at) > 5000) throw new AppError('双腿深度时间差超过 5 秒');
}
export function fill(levels, quantity, side, slippageBps) {
  const top = levels[0][0], limit = top * (1 + (side === 'buy' ? 1 : -1) * slippageBps / 10000);
  let remaining = quantity, value = 0;
  for (const [price, available] of levels) {
    if (side === 'buy' ? price > limit + 1e-12 : price < limit - 1e-12) break;
    const take = Math.min(remaining, available); value += take * price; remaining -= take;
    if (remaining < quantity * 1e-10) return { quantity, price: value / quantity, notional: value, status: 'filled' };
  }
  throw new AppError('滑点上限内深度不足，双腿模拟均未记账');
}
export function pnl(position, longExit, shortExit, fx, now = Date.now()) {
  const longGross = position.quantity * (longExit - position.longFill.price), shortGross = position.quantity * (position.shortFill.price - shortExit);
  const gross = convert(longGross, settlement(position.long), fx, now) + convert(shortGross, settlement(position.short), fx, now);
  const exitFees = (notionalUSDT(position.long, position.quantity * longExit, fx, now) + notionalUSDT(position.short, position.quantity * shortExit, fx, now)) * position.feeBps / 10000;
  return { gross, exitFees, net: gross - position.entryFees - exitFees, longGross, shortGross };
}
