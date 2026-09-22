import WebSocket from 'ws';
import { AppError, monitorUrl, validIdentity } from './model.mjs';
import { publicSnapshot } from './public-snapshot.mjs';

export const CATALOG_URL = 'https://api.gateio.ws/api/v4/crossex/rule/symbols';
const HYPERLIQUID_INFO = 'https://api.hyperliquid.xyz/info';
const LIGHTER_MARKETS = 'https://mainnet.zklighter.elliot.ai/api/v1/orderBookDetails';
const KRAKEN_MARKETS = 'https://futures.kraken.com/derivatives/api/v3/instruments';
const BINANCE_MARKETS = 'https://fapi.binance.com/fapi/v1/exchangeInfo';
// Official contract/quantity and snapshot formats, checked 2026-09-22:
// https://www.okx.com/docs-v5/en/#public-data-rest-api-get-instruments
// https://www.gate.com/docs/developers/apiv4/en/#get-a-single-contract
// https://docs.kraken.com/api-reference/instrument-details/get-instruments
// https://docs.kraken.com/exchange/api-reference/futures-websocket/book
// https://hyperliquid.gitbook.io/hyperliquid-docs/trading/contract-specifications
// https://apidocs.lighter.xyz/docs/websocket-reference
const MAX_BYTES = 8 * 1024 * 1024, FX_MAX_AGE = 180_000;
const positive = value => (typeof value === 'number' || typeof value === 'string' && value.trim() !== '') && Number.isFinite(Number(value)) && Number(value) > 0;
const failure = message => new AppError(message, 502);
const baseName = name => name === 'XBT' ? 'BTC' : name;

// Match Monitor's crypto classification at the final depth boundary as well.
// A saved identityVerified flag is insufficient when the current feed is absent.
function binanceCrypto(row) {
  return row?.underlyingType === 'COIN' && row.contractType === 'PERPETUAL' && row.status === 'TRADING'
    && ['USDT', 'USDC'].includes(row.quoteAsset) && row.marginAsset === row.quoteAsset
    && row.symbol === `${row.baseAsset}${row.quoteAsset}` && Array.isArray(row.underlyingSubType)
    && row.underlyingSubType.every(value => typeof value === 'string'
      && !/pre.?launch|pre.?market|pre.?ipo/.test(value.toLowerCase())
      && !['stock', 'etf', 'commodities', 'commodity', 'forex', 'index', 'indices', 'tradfi'].includes(value.toLowerCase()));
}

async function readJson(url, init, { fetcher = fetch, maxBytes = MAX_BYTES, timeoutMs = 8000 } = {}) {
  const response = await fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    await response.body?.cancel();
    const error = failure(response.status === 401 ? '来源认证失败，请检查价差模块登录信息' : `只读来源响应 ${response.status}`);
    error.sourceStatus = response.status; throw error;
  }
  const chunks = []; let length = 0;
  if (response.body) for await (const chunk of response.body) {
    length += chunk.length;
    if (length > maxBytes) throw failure('来源响应过大');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw failure('来源没有返回有效 JSON'); }
}

/** The generic reader remains GET-only. Public POST is confined to Hyperliquid /info below. */
export function getJson(url, { headers = {}, ...options } = {}) {
  return readJson(url, { method: 'GET', headers: { Accept: 'application/json', ...headers } }, options);
}

function sourceTime(value, now, maxAge = 10_000) {
  const at = Number(value);
  if (!positive(value) || at < 1e12 || at > now + 1000 || now - at > maxAge) throw failure('来源盘口已经过期或缺少有效时间');
  return at;
}

function levels(rows, unit = 1) {
  if (!Array.isArray(rows) || !rows.length || rows.length > 20_000) throw failure('深度快照缺失或过大');
  // Preserve the exchange's ordering: invalid/duplicate levels are never silently repaired.
  return rows.slice(0, 100).map(row => {
    const price = Array.isArray(row) ? row[0] : row?.p ?? row?.px ?? row?.price;
    const quantity = Array.isArray(row) ? row[1] : row?.s ?? row?.sz ?? row?.size ?? row?.qty;
    if (!positive(price) || !positive(quantity) || !positive(Number(quantity) * unit)) throw failure('深度快照价格或数量无效');
    return [Number(price), Number(quantity) * unit];
  });
}

/** Public, bounded one-shot readers. No API key, account endpoint, signer or order endpoint. */
export function createPublicClients({ fetcher = fetch, WebSocketImpl = WebSocket, clock = Date.now, timeoutMs = 8000 } = {}) {
  const options = { fetcher, timeoutMs }, metadata = new Map();
  let fxSnapshot = null, fxFlight = null, fxAttemptAt = -Infinity;
  const get = url => getJson(url, options);
  const info = (type, coin) => {
    if (!['meta', 'l2Book'].includes(type)) throw new AppError('不支持的公开查询');
    return readJson(HYPERLIQUID_INFO, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(type === 'meta' ? { type } : { type, coin }) }, options);
  };
  async function cached(key, loader) {
    const previous = metadata.get(key), now = clock();
    if (previous?.flight) return previous.flight;
    if (previous?.value && now >= previous.at && now - previous.at < 300_000) return previous.value;
    if (metadata.size >= 128 && !metadata.has(key)) {
      const oldest = [...metadata].find(([, entry]) => !entry.flight);
      if (!oldest) throw failure('公开目录查询繁忙，请稍后重试');
      metadata.delete(oldest[0]);
    }
    const entry = { at: now, value: null, flight: null };
    entry.flight = loader().then(value => { entry.value = value; entry.at = clock(); return value; }).finally(() => { entry.flight = null; });
    metadata.set(key, entry); return entry.flight;
  }
  async function contract(quote) {
    const { exchange, symbol, base, quoteCurrency } = quote, rawBase = quote.rawBase ?? base;
    const settle = quote.settlementCurrency ?? quote.collateralCurrency, encoded = encodeURIComponent(symbol);
    let row, unit = 1;
    if (exchange === 'binance') {
      const data = await cached('binance', () => get(BINANCE_MARKETS));
      row = data.symbols?.find(item => item.symbol === symbol);
      if (!binanceCrypto(row) || row.baseAsset !== rawBase || baseName(row.baseAsset) !== base || row.quoteAsset !== quoteCurrency || row.marginAsset !== settle) throw failure('Binance 合约身份或交易状态未确认');
    } else if (exchange === 'bybit') {
      const data = await cached(`bybit:${symbol}`, () => get(`https://api.bybit.com/v5/market/instruments-info?category=linear&symbol=${encoded}`));
      row = data.result?.list?.find(item => item.symbol === symbol);
      if (data.retCode !== 0 || data.result?.category !== 'linear' || !row || row.baseCoin !== rawBase || baseName(row.baseCoin) !== base || row.quoteCoin !== quoteCurrency || row.settleCoin !== settle || row.contractType !== 'LinearPerpetual' || row.status !== 'Trading' || row.isPreListing === true || Number(row.deliveryTime) > 0 || (typeof row.symbolType !== 'string' || !['', 'crypto', 'innovation'].includes(row.symbolType.toLowerCase())) || row.marketRegion || row.underlyingTicker) throw failure('Bybit 合约身份或交易状态未确认');
    } else if (exchange === 'okx') {
      const data = await cached(`okx:${symbol}`, () => get(`https://www.okx.com/api/v5/public/instruments?instType=SWAP&instId=${encoded}`));
      row = data.data?.find(item => item.instId === symbol);
      if (data.code !== '0' || !row || row.instType !== 'SWAP' || row.ctType !== 'linear' || row.ctValCcy !== rawBase || baseName(row.ctValCcy) !== base || row.settleCcy !== settle || row.state !== 'live' || row.ruleType !== 'normal' || Number(row.expTime) > 0 || !['1', '2'].includes(row.instCategory) || row.instId !== `${rawBase}-${quoteCurrency}-SWAP` || !positive(row.ctVal) || Number(row.ctMult) !== 1) throw failure('OKX 合约数量单位或身份未确认');
      unit = Number(row.ctVal);
    } else if (exchange === 'gate') {
      row = await cached(`gate:${symbol}`, () => get(`https://api.gateio.ws/api/v4/futures/usdt/contracts/${encoded}`));
      if (quoteCurrency !== 'USDT' || settle !== 'USDT' || row.name !== symbol || symbol !== `${rawBase}_USDT` || baseName(rawBase) !== base || row.type !== 'direct' || row.in_delisting !== false || !['', 'crypto'].includes(row.contract_type) || row.is_pre_market !== false || (row.status !== undefined && row.status !== 'trading') || !positive(row.quanto_multiplier)) throw failure('Gate 合约数量单位或身份未确认');
      unit = Number(row.quanto_multiplier);
    } else if (exchange === 'kraken') {
      const data = await cached('kraken', () => get(KRAKEN_MARKETS));
      row = data.instruments?.find(item => item.symbol === symbol);
      if (data.result !== 'success' || !row || row.type !== 'flexible_futures' || row.tradeable !== true || row.isExpired !== false || row.postOnly === true || row.tradfi !== false || baseName(row.base) !== base || baseName(rawBase) !== base || row.quote !== 'USD' || quoteCurrency !== 'USD' || settle !== 'USD' || Number(row.contractSize) !== 1) throw failure('Kraken 线性永续合约身份或数量单位未确认');
    } else if (exchange === 'hyperliquid') {
      const data = await cached('hyperliquid', () => info('meta'));
      row = data.universe?.find(item => item.name === symbol);
      if (!row || row.name !== rawBase || baseName(row.name) !== base || row.isDelisted === true || !Number.isInteger(row.szDecimals) || row.szDecimals < 0 || !positive(row.maxLeverage) || data.collateralToken !== 0 || settle !== 'USDC' || quoteCurrency !== (['HYPE', 'PURR'].includes(symbol) ? 'USDC' : 'USDT')) throw failure('Hyperliquid 合约身份或结算币未确认');
    } else if (exchange === 'lighter') {
      const data = await cached('lighter', () => get(LIGHTER_MARKETS));
      row = data.order_book_details?.find(item => item.symbol === symbol && item.market_type === 'perp');
      if (data.code !== 200 || !row || row.symbol !== rawBase || baseName(row.symbol) !== base || row.status !== 'active' || row.is_frozen === true || row.market_config?.force_reduce_only === true || Number(row.funding_premium_multiplier) !== 100 || quoteCurrency !== 'USDC' || settle !== 'USDC' || Number(row.multiplier) !== 1 || !Number.isInteger(row.market_id) || row.market_id < 0 || row.market_id !== quote.marketId) throw failure('Lighter 合约身份、单位或 market_id 已变化');
    } else throw new AppError('不支持的深度合约');
    if (exchange !== 'binance') {
      const independent = await cached('binance', () => get(BINANCE_MARKETS));
      if (!independent.symbols?.some(item => item.baseAsset === base && binanceCrypto(item))) throw failure('缺少当前独立 Binance COIN 基础币身份，不能确认跨所合约');
    }
    return { row, unit };
  }
  async function loadDepth(quote) {
    if (!validIdentity(quote)) throw new AppError('不支持的深度合约');
    const { exchange, symbol } = quote, encoded = encodeURIComponent(symbol), { row, unit } = await contract(quote);
    let data, bids, asks, at, source, transport = 'rest';
    if (exchange === 'binance') {
      source = `https://fapi.binance.com/fapi/v1/depth?symbol=${encoded}&limit=100`;
      data = await get(source); ({ bids, asks } = data); at = data.T;
    } else if (exchange === 'bybit') {
      source = `https://api.bybit.com/v5/market/orderbook?category=linear&symbol=${encoded}&limit=100`;
      data = await get(source);
      if (data.retCode !== 0 || data.result?.s !== symbol) throw failure('Bybit 深度响应无效');
      ({ b: bids, a: asks } = data.result); at = data.result.cts ?? data.result.ts;
    } else if (exchange === 'okx') {
      source = `https://www.okx.com/api/v5/market/books?instId=${encoded}&sz=100`;
      data = await get(source);
      if (data.code !== '0' || data.data?.length !== 1) throw failure('OKX 深度响应无效');
      ({ bids, asks, ts: at } = data.data[0]);
    } else if (exchange === 'gate') {
      source = `https://api.gateio.ws/api/v4/futures/usdt/order_book?contract=${encoded}&limit=100`;
      data = await get(source); ({ bids, asks } = data); at = Number(data.update) * 1000;
    } else if (exchange === 'hyperliquid') {
      source = HYPERLIQUID_INFO; data = await info('l2Book', symbol);
      if (data.coin !== symbol) throw failure('Hyperliquid 深度合约不一致');
      [bids, asks] = data.levels ?? []; at = data.time;
    } else if (exchange === 'kraken') {
      source = 'wss://futures.kraken.com/ws/v1'; transport = 'ws';
      data = await publicSnapshot({ source, WebSocketImpl, timeoutMs, subscription: { event: 'subscribe', feed: 'book', product_ids: [symbol] }, accept: value => {
        if (value.feed !== 'book_snapshot') return false;
        if (value.product_id !== symbol) throw failure('Kraken 深度合约不一致');
        return true;
      } });
      ({ bids, asks, timestamp: at } = data);
    } else {
      source = 'wss://mainnet.zklighter.elliot.ai/stream?readonly=true'; transport = 'ws';
      data = await publicSnapshot({ source, WebSocketImpl, timeoutMs, subscription: { type: 'subscribe', channel: `order_book/${row.market_id}` }, accept: value => {
        if (value.type !== 'subscribed/order_book') return false;
        if (value.channel !== `order_book:${row.market_id}` || value.order_book?.code !== 0) throw failure('Lighter 深度合约或响应无效');
        return true;
      } });
      ({ bids, asks } = data.order_book);
      at = sourceTime(data.timestamp, clock());
      // Lighter matching-engine time is microseconds; envelope time is milliseconds.
      const changed = data.order_book.last_updated_at ?? data.last_updated_at;
      if (changed !== undefined) at = Math.min(at, sourceTime(Number(changed) / 1000, clock()));
    }
    const receivedAt = clock();
    const book = { exchange, symbol, base: quote.base, quoteCurrency: quote.quoteCurrency, at: sourceTime(at, receivedAt), receivedAt, source, transport, bids: levels(bids, unit), asks: levels(asks, unit) };
    for (const side of ['bids', 'asks']) for (let i = 1; i < book[side].length; i++) {
      if (side === 'bids' ? book[side][i][0] >= book[side][i - 1][0] : book[side][i][0] <= book[side][i - 1][0]) throw failure('深度快照价格排序异常');
    }
    if (book.bids[0][0] > book.asks[0][0]) throw failure('深度快照买卖价交叉');
    return book;
  }
  function validRate(rate, now) {
    return rate && positive(rate.bid) && positive(rate.ask) && rate.bid <= rate.ask && Number.isFinite(rate.at) && rate.at >= 1e12 && rate.at <= now + 1000 && now - rate.at <= FX_MAX_AGE;
  }
  async function loadFx() {
    if (fxFlight) return fxFlight;
    const now = clock();
    if (fxSnapshot && now >= fxAttemptAt && now - fxAttemptAt < 60_000) return fxSnapshot;
    fxAttemptAt = now;
    fxFlight = (async () => {
      const rates = { USDT: { bid: 1, ask: 1, at: now, source: 'USDT 计价基准' } }, reasons = {};
      await Promise.all(['USDC', 'USD'].map(async currency => {
        const source = currency === 'USDC' ? 'https://api.gateio.ws/api/v4/spot/order_book?currency_pair=USDC_USDT&limit=1' : 'https://api.kraken.com/0/public/Depth?pair=USDTUSD&count=1';
        try {
          const data = await get(source);
          let bid, ask, at;
          if (currency === 'USDC') {
            bid = data.bids?.[0]; ask = data.asks?.[0]; at = sourceTime(data.update, clock(), FX_MAX_AGE);
          } else {
            if (!Array.isArray(data.error) || data.error.length || !data.result?.USDTZUSD) throw failure('Kraken USD 汇率响应无效');
            bid = data.result.USDTZUSD.bids?.[0]; ask = data.result.USDTZUSD.asks?.[0];
            at = Math.min(sourceTime(Number(bid?.[2]) * 1000, clock(), FX_MAX_AGE), sourceTime(Number(ask?.[2]) * 1000, clock(), FX_MAX_AGE));
          }
          if (![bid?.[0], bid?.[1], ask?.[0], ask?.[1]].every(positive) || Number(bid[0]) > Number(ask[0])) throw failure('汇率盘口缺失或交叉');
          const rate = currency === 'USD' ? { bid: 1 / Number(ask[0]), ask: 1 / Number(bid[0]), at, source } : { bid: Number(bid[0]), ask: Number(ask[0]), at, source };
          if (!validRate(rate, clock())) throw failure('汇率盘口无效或过期');
          if (fxSnapshot?.rates?.[currency]?.at > rate.at) throw failure('汇率来源时间回退');
          rates[currency] = rate;
        } catch (error) {
          const previous = fxSnapshot?.rates?.[currency];
          if (validRate(previous, clock())) rates[currency] = previous;
          reasons[currency] = `${rates[currency] ? '更新失败，沿用未过期的来源汇率：' : ''}${error instanceof AppError ? error.message : '公开汇率读取失败'}`;
        }
      }));
      return fxSnapshot = { baseCurrency: 'USDT', generatedAt: clock(), staleAfterMs: FX_MAX_AGE, rates, reasons };
    })().finally(() => { fxFlight = null; });
    return fxFlight;
  }
  const loadCatalog = () => get(CATALOG_URL);
  async function loadFeed(config, password) {
    const url = `${monitorUrl(config.monitorUrl)}/api/monitors/perpetual/opportunities-v2`;
    try { return await getJson(url, { ...options, headers: password ? { Authorization: `Basic ${Buffer.from(`${config.monitorUsername}:${password}`).toString('base64')}` } : {} }); }
    catch (error) { if (error.sourceStatus === 404) throw failure('价差服务缺少新版七所信号接口，请先升级 Monitor'); throw error; }
  }
  return { loadCatalog, loadFeed, loadDepth, loadFx };
}

const clients = createPublicClients();
export const loadCatalog = clients.loadCatalog;
export const loadFeed = clients.loadFeed;
export const loadDepth = clients.loadDepth;
export const loadFx = clients.loadFx;
