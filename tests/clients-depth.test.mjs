import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createPublicClients } from '../server/clients.mjs';
import { publicSnapshot } from '../server/public-snapshot.mjs';

const NOW = 1790067200000;
function quote(exchange, currency = 'USDT', base = 'BTC') {
  const symbol = { binance: `${base}${currency}`, bybit: currency === 'USDC' ? `${base}PERP` : `${base}${currency}`, okx: `${base}-${currency}-SWAP`, gate: `${base}_USDT`, kraken: `PF_${base === 'BTC' ? 'XBT' : base}USD`, hyperliquid: base, lighter: base }[exchange];
  const settlementCurrency = exchange === 'hyperliquid' ? 'USDC' : currency;
  return { exchange, symbol, base, rawBase: base, quoteCurrency: currency, settlementCurrency, collateralCurrency: exchange === 'kraken' ? 'MULTI' : settlementCurrency, counterCurrency: settlementCurrency, contractKind: exchange === 'hyperliquid' && currency === 'USDT' ? 'quanto' : 'linear', crossexSymbol: `${exchange.toUpperCase()}_FUTURE_${base}_${settlementCurrency}`, multiplier: 1, assetClass: 'crypto', identityVerified: true, identitySource: 'official-fixture', comparable: true, ...(exchange === 'lighter' ? { marketId: 1 } : {}) };
}
const rows = { bids: [['100', '20'], ['99', '10']], asks: [['101', '30'], ['102', '15']] };
const objects = key => rows[key].map(([price, size]) => ({ price, size }));
function socketFixture(messages) {
  return class Socket extends EventEmitter {
    static instances = [];
    constructor(url, options) { super(); this.url = url; this.options = options; this.sent = []; this.terminated = false; this.constructor.instances.push(this); queueMicrotask(() => this.emit('open')); }
    send(raw) { this.sent.push(JSON.parse(raw)); if (this.sent.length === 1) queueMicrotask(() => { for (const value of messages) if (!this.terminated) this.emit('message', Buffer.from(typeof value === 'string' ? value : JSON.stringify(value))); }); }
    terminate() { this.terminated = true; }
  };
}
function fixture(q, overrides = {}) {
  const binance = { symbols: [{ symbol: `${q.base}${q.exchange === 'binance' ? q.quoteCurrency : 'USDT'}`, baseAsset: q.base, quoteAsset: q.exchange === 'binance' ? q.quoteCurrency : 'USDT', marginAsset: q.exchange === 'binance' ? q.quoteCurrency : 'USDT', contractType: 'PERPETUAL', status: 'TRADING', underlyingType: 'COIN', underlyingSubType: ['PoW', 'Crypto'] }] };
  const requests = [], metadata = {
    binance,
    bybit: { retCode: 0, result: { category: 'linear', list: [{ symbol: q.symbol, baseCoin: q.base, quoteCoin: q.quoteCurrency, settleCoin: q.settlementCurrency, contractType: 'LinearPerpetual', status: 'Trading', symbolType: '', deliveryTime: '0', isPreListing: false }] } },
    okx: { code: '0', data: [{ instId: q.symbol, instType: 'SWAP', ctType: 'linear', ctValCcy: q.base, settleCcy: q.settlementCurrency, state: 'live', instCategory: '1', ruleType: 'normal', ctVal: '0.01', ctMult: '1' }] },
    gate: { name: q.symbol, type: 'direct', contract_type: '', is_pre_market: false, quanto_multiplier: '0.0001', in_delisting: false },
    kraken: { result: 'success', instruments: [{ symbol: q.symbol, type: 'flexible_futures', base: 'XBT', quote: 'USD', contractSize: 1, tradeable: true, postOnly: false, isExpired: false, tradfi: false }] },
    hyperliquid: { collateralToken: 0, universe: [{ name: q.symbol, szDecimals: 5, maxLeverage: 40, isDelisted: false }] },
    lighter: { code: 200, order_book_details: [{ symbol: q.symbol, market_id: 1, market_type: 'perp', multiplier: '1', status: 'active', funding_premium_multiplier: 100 }] },
  }[q.exchange];
  const depth = {
    binance: { T: NOW, ...rows },
    bybit: { retCode: 0, result: { s: q.symbol, cts: NOW, ts: NOW + 2, b: rows.bids, a: rows.asks } },
    okx: { code: '0', data: [{ ts: String(NOW), ...rows }] },
    gate: { update: NOW / 1000, current: NOW / 1000 + 2, bids: rows.bids.map(([p, s]) => ({ p, s })), asks: rows.asks.map(([p, s]) => ({ p, s })) },
    hyperliquid: { coin: q.symbol, time: NOW, levels: [rows.bids.map(([px, sz]) => ({ px, sz })), rows.asks.map(([px, sz]) => ({ px, sz }))] },
  }[q.exchange];
  return { metadata, binance, depth, requests, fetcher: async (url, init) => {
    requests.push({ url, init });
    assert.equal(init.headers.Authorization, undefined); assert.equal(init.redirect, 'error'); assert.ok(init.signal);
    if (init.method === 'POST') { assert.equal(url, 'https://api.hyperliquid.xyz/info'); assert.ok(['meta', 'l2Book'].includes(JSON.parse(init.body).type)); }
    else assert.equal(init.method, 'GET');
    if (url.endsWith('/exchangeInfo') && q.exchange !== 'binance') return new Response(JSON.stringify(overrides.binance ?? binance));
    const isMetadata = /exchangeInfo|instruments-info|public\/instruments|contracts\/|v3\/instruments|orderBookDetails/.test(url) || JSON.parse(init.body || '{}').type === 'meta';
    return new Response(JSON.stringify(isMetadata ? overrides.metadata ?? metadata : overrides.depth ?? depth));
  } };
}

for (const [exchange, currency, expectedUnit] of [['binance', 'USDT', 1], ['binance', 'USDC', 1], ['bybit', 'USDT', 1], ['bybit', 'USDC', 1], ['okx', 'USDT', 0.01], ['okx', 'USDC', 0.01], ['gate', 'USDT', 0.0001], ['hyperliquid', 'USDT', 1]]) {
  test(`${exchange} ${currency}: official identity, source time and base quantity retain native prices`, async () => {
    const q = quote(exchange, currency), f = fixture(q), clients = createPublicClients({ fetcher: f.fetcher, clock: () => NOW + 100 });
    const book = await clients.loadDepth(q);
    assert.equal(book.at, NOW); assert.equal(book.quoteCurrency, currency); assert.equal(book.symbol, q.symbol);
    assert.deepEqual(book.bids, [[100, 20 * expectedUnit], [99, 10 * expectedUnit]]);
    assert.equal(book.asks[0][0], 101); assert.equal(book.receivedAt, NOW + 100);
    await clients.loadDepth(q); assert.equal(f.requests.length, exchange === 'binance' ? 3 : 4, 'verified native and independent metadata are reused, every depth read remains fresh');
  });
}

test('Hyperliquid HYPE uses USDC and sends only public metadata/L2 POST bodies', async () => {
  const q = quote('hyperliquid', 'USDC', 'HYPE'), f = fixture(q), clients = createPublicClients({ fetcher: f.fetcher, clock: () => NOW });
  assert.equal((await clients.loadDepth(q)).quoteCurrency, 'USDC');
  assert.deepEqual(f.requests.filter(r => r.init.method === 'POST').map(r => JSON.parse(r.init.body)), [{ type: 'meta' }, { type: 'l2Book', coin: 'HYPE' }]);
});

test('Kraken reads only complete matching snapshots, ignores deltas and uses exchange timestamp', async () => {
  const q = quote('kraken', 'USD'), f = fixture(q);
  const Socket = socketFixture([{ feed: 'book', product_id: q.symbol, timestamp: NOW + 50, bids: objects('bids'), asks: objects('asks') }, { feed: 'book_snapshot', product_id: q.symbol, timestamp: NOW, bids: objects('bids'), asks: objects('asks') }]);
  const clients = createPublicClients({ fetcher: f.fetcher, WebSocketImpl: Socket, clock: () => NOW + 100 });
  const book = await clients.loadDepth(q), socket = Socket.instances[0];
  assert.equal(book.at, NOW); assert.equal(book.quoteCurrency, 'USD'); assert.deepEqual(book.bids, [[100, 20], [99, 10]]);
  assert.deepEqual(socket.sent, [{ event: 'subscribe', feed: 'book', product_ids: ['PF_XBTUSD'] }]);
  assert.equal(socket.terminated, true); assert.equal(socket.options.followRedirects, false); assert.equal(socket.options.maxPayload, 8 * 1024 * 1024);
});

test('Lighter validates market_id against official metadata and accepts initial snapshot only', async () => {
  const q = quote('lighter', 'USDC'), f = fixture(q);
  const Socket = socketFixture([{ type: 'ping' }, { type: 'update/order_book', channel: 'order_book:1', timestamp: NOW }, { type: 'subscribed/order_book', channel: 'order_book:1', timestamp: NOW, order_book: { code: 0, last_updated_at: (NOW - 50) * 1000, bids: objects('bids'), asks: objects('asks') } }]);
  const clients = createPublicClients({ fetcher: f.fetcher, WebSocketImpl: Socket, clock: () => NOW + 100 });
  const book = await clients.loadDepth(q), socket = Socket.instances[0];
  assert.equal(book.at, NOW - 50); assert.equal(book.quoteCurrency, 'USDC'); assert.deepEqual(book.asks, [[101, 30], [102, 15]]);
  assert.deepEqual(socket.sent, [{ type: 'subscribe', channel: 'order_book/1' }, { type: 'pong' }]); assert.equal(socket.terminated, true);
  await assert.rejects(clients.loadDepth({ ...q, marketId: 2 }), /market_id/); assert.equal(Socket.instances.length, 1);
});

test('metadata cache is refreshed after expiry and a changed contract is rejected', async () => {
  let now = NOW;
  const q = quote('okx'), f = fixture(q), clients = createPublicClients({ fetcher: f.fetcher, clock: () => now });
  await clients.loadDepth(q); now += 300_001; f.metadata.data[0].ctType = 'inverse';
  await assert.rejects(clients.loadDepth(q), /单位或身份/);
  assert.equal(f.requests.length, 4);
});

test('incorrect official unit, identity, status, or settlement blocks the depth read', async () => {
  for (const [exchange, currency, change] of [
    ['binance', 'USDT', x => { x.symbols[0].marginAsset = 'BTC'; }],
    ['bybit', 'USDC', x => { x.result.list[0].settleCoin = 'USDT'; }],
    ['bybit', 'USDT', x => { x.result.list[0].contractType = 'LinearFutures'; }],
    ['bybit', 'USDT', x => { x.result.list[0].symbolType = 'xstocks'; }],
    ['okx', 'USDT', x => { x.data[0].ctValCcy = 'USD'; }],
    ['okx', 'USDT', x => { x.data[0].ctMult = '100'; }],
    ['okx', 'USDT', x => { x.data[0].ruleType = 'pre_market'; }],
    ['okx', 'USDT', x => { x.data[0].expTime = String(NOW + 60000); }],
    ['gate', 'USDT', x => { x.quanto_multiplier = '0'; }],
    ['gate', 'USDT', x => { x.in_delisting = true; }],
    ['gate', 'USDT', x => { x.status = 'reduce_only'; }],
    ['gate', 'USDT', x => { x.is_pre_market = true; }],
    ['kraken', 'USD', x => { x.instruments[0].type = 'futures_inverse'; }],
    ['kraken', 'USD', x => { x.instruments[0].contractSize = 10; }],
    ['kraken', 'USD', x => { delete x.instruments[0].tradfi; }],
    ['kraken', 'USD', x => { delete x.instruments[0].isExpired; }],
    ['hyperliquid', 'USDT', x => { x.universe[0].isDelisted = true; }],
    ['lighter', 'USDC', x => { x.order_book_details[0].multiplier = '1000'; }],
  ]) {
    const q = quote(exchange, currency), f = fixture(q); change(f.metadata);
    const clients = createPublicClients({ fetcher: f.fetcher, clock: () => NOW });
    await assert.rejects(clients.loadDepth(q), /未确认|变化/); assert.equal(f.requests.length, 1);
  }
});

test('fresh response time never rejuvenates an old Gate book or Lighter matching-engine time', async () => {
  const q = quote('gate'), f = fixture(q); f.depth.update = (NOW - 10_001) / 1000; f.depth.current = NOW / 1000;
  await assert.rejects(createPublicClients({ fetcher: f.fetcher, clock: () => NOW }).loadDepth(q), /过期/);
  const l = quote('lighter', 'USDC'), lf = fixture(l), Socket = socketFixture([{ type: 'subscribed/order_book', channel: 'order_book:1', timestamp: NOW, order_book: { code: 0, last_updated_at: (NOW - 10_001) * 1000, bids: objects('bids'), asks: objects('asks') } }]);
  await assert.rejects(createPublicClients({ fetcher: lf.fetcher, clock: () => NOW, WebSocketImpl: Socket }).loadDepth(l), /过期/);
});

test('invalid symbols, multipliers and the excluded venue make no public requests', async () => {
  let requests = 0;
  const clients = createPublicClients({ fetcher: async () => { requests++; throw Error('unexpected'); } });
  for (const patch of [{ exchange: 'deribit' }, { multiplier: 1000 }, { symbol: 'BTCUSDT&other=1' }, { identityVerified: false }]) await assert.rejects(clients.loadDepth({ ...quote('binance'), ...patch }), /不支持/);
  assert.equal(requests, 0);
});

test('snapshots fail closed on wrong products, missing time, crossed books and malformed levels', async () => {
  const q = quote('kraken', 'USD'), f = fixture(q);
  for (const change of [value => { value.product_id = 'PF_ETHUSD'; }, value => { delete value.timestamp; }, value => { value.timestamp = NOW + 1001; }, value => { value.bids[0].price = '102'; }, value => { value.asks[0].size = null; }]) {
    const message = { feed: 'book_snapshot', product_id: q.symbol, timestamp: NOW, bids: objects('bids'), asks: objects('asks') }; change(message);
    const Socket = socketFixture([message]), clients = createPublicClients({ fetcher: f.fetcher, clock: () => NOW, WebSocketImpl: Socket });
    await assert.rejects(clients.loadDepth(q), /不一致|过期|交叉|无效|排序/); assert.equal(Socket.instances[0].terminated, true);
  }
});

test('one-shot socket terminates on malformed data and timeout; subscription cannot send transactions', async () => {
  const q = quote('kraken', 'USD'), f = fixture(q);
  for (const messages of [[], ['not json'], [{ event: 'error', message: 'no' }]]) {
    const Socket = socketFixture(messages), clients = createPublicClients({ fetcher: f.fetcher, WebSocketImpl: Socket, clock: () => NOW, timeoutMs: 20 });
    await assert.rejects(clients.loadDepth(q), /超时|格式|订阅/); assert.equal(Socket.instances[0].terminated, true);
  }
  assert.throws(() => publicSnapshot({ source: 'wss://mainnet.zklighter.elliot.ai/stream?readonly=true', subscription: { type: 'jsonapi/sendtx', data: {} } }), /仅允许/);
});

test('Monitor-supported Bybit innovation and OKX category 2 remain usable; unknown metadata rejects', async () => {
  for (const [exchange, field, supported] of [['bybit', 'symbolType', 'innovation'], ['okx', 'instCategory', '2']]) {
    const q = quote(exchange), f = fixture(q), row = exchange === 'bybit' ? f.metadata.result.list[0] : f.metadata.data[0];
    row[field] = supported;
    assert.ok((await createPublicClients({ fetcher: f.fetcher, clock: () => NOW }).loadDepth(q)).bids.length);
    for (const invalid of [undefined, 'unknown', 'stock']) {
      row[field] = invalid;
      await assert.rejects(createPublicClients({ fetcher: f.fetcher, clock: () => NOW }).loadDepth(q), /身份/);
    }
  }
});

test('saved identity flags cannot bypass missing or newly non-crypto native classification', async () => {
  for (const [exchange, currency, change] of [
    ['binance', 'USDT', x => { delete x.symbols[0].underlyingType; }],
    ['binance', 'USDT', x => { x.symbols[0].underlyingType = 'STOCK'; }],
    ['binance', 'USDT', x => { delete x.symbols[0].underlyingSubType; }],
    ['binance', 'USDT', x => { x.symbols[0].underlyingSubType = ['stock']; }],
    ['binance', 'USDT', x => { x.symbols[0].underlyingSubType = ['ETF']; }],
    ['binance', 'USDT', x => { x.symbols[0].underlyingSubType = ['pre-IPO']; }],
    ['gate', 'USDT', x => { delete x.contract_type; }],
    ['gate', 'USDT', x => { x.contract_type = 'stocks'; }],
    ['gate', 'USDT', x => { delete x.is_pre_market; }],
    ['lighter', 'USDC', x => { delete x.order_book_details[0].funding_premium_multiplier; }],
    ['lighter', 'USDC', x => { x.order_book_details[0].funding_premium_multiplier = 50; }],
    ['lighter', 'USDC', x => { x.order_book_details[0].funding_premium_multiplier = 1; }],
    ['hyperliquid', 'USDT', x => { delete x.universe[0].szDecimals; }],
    ['hyperliquid', 'USDT', x => { x.universe[0].szDecimals = -1; }],
    ['hyperliquid', 'USDT', x => { x.universe[0].szDecimals = 1.5; }],
    ['hyperliquid', 'USDT', x => { delete x.universe[0].maxLeverage; }],
    ['hyperliquid', 'USDT', x => { x.universe[0].maxLeverage = 0; }],
    ['hyperliquid', 'USDT', x => { delete x.collateralToken; }],
    ['hyperliquid', 'USDT', x => { x.collateralToken = 1; }],
  ]) {
    const q = quote(exchange, currency), f = fixture(q); change(f.metadata);
    const Socket = socketFixture([]), clients = createPublicClients({ fetcher: f.fetcher, WebSocketImpl: Socket, clock: () => NOW });
    await assert.rejects(clients.loadDepth(q), /未确认|变化/);
    assert.equal(f.requests.length, 1, 'contradictory native metadata blocks all depth requests');
    assert.equal(Socket.instances.length, 0);
  }
});

test('every non-Binance venue rechecks independent COIN evidence even without a current feed quote', async () => {
  for (const [exchange, currency] of [['bybit', 'USDT'], ['okx', 'USDT'], ['gate', 'USDT'], ['kraken', 'USD'], ['hyperliquid', 'USDT'], ['lighter', 'USDC']]) {
    for (const change of [
      x => { x.symbols = []; },
      x => { delete x.symbols[0].underlyingType; },
      x => { x.symbols[0].underlyingSubType = ['stock']; },
      x => { x.symbols[0].baseAsset = 'ETH'; x.symbols[0].symbol = 'ETHUSDT'; },
      x => { x.symbols[0].status = 'SETTLING'; },
    ]) {
      const q = quote(exchange, currency), f = fixture(q); change(f.binance);
      const Socket = socketFixture([]), clients = createPublicClients({ fetcher: f.fetcher, WebSocketImpl: Socket, clock: () => NOW });
      await assert.rejects(clients.loadDepth(q), /独立 Binance COIN/);
      assert.equal(f.requests.length, 2, 'reads both directories, never a book'); assert.equal(Socket.instances.length, 0);
    }
  }
});

test('native classification withdrawal after metadata cache expiry blocks another depth read', async () => {
  for (const [exchange, currency, change] of [
    ['binance', 'USDT', x => { x.symbols[0].underlyingSubType = ['stock']; }],
    ['gate', 'USDT', x => { x.contract_type = 'stocks'; }],
    ['hyperliquid', 'USDT', x => { x.collateralToken = 1; }],
    ['lighter', 'USDC', x => { x.order_book_details[0].funding_premium_multiplier = 50; }],
  ]) {
    let now = NOW;
    const q = quote(exchange, currency), f = fixture(q);
    const Socket = socketFixture([{ type: 'subscribed/order_book', channel: 'order_book:1', timestamp: NOW, order_book: { code: 0, bids: objects('bids'), asks: objects('asks') } }]);
    const clients = createPublicClients({ fetcher: f.fetcher, WebSocketImpl: Socket, clock: () => now });
    await clients.loadDepth(q); const previousRequests = f.requests.length, previousSockets = Socket.instances.length;
    change(f.metadata); now += 300_001;
    await assert.rejects(clients.loadDepth(q), /未确认|变化/);
    assert.equal(f.requests.length, previousRequests + 1); assert.equal(Socket.instances.length, previousSockets);
  }
});

test('expired independent evidence is refreshed and cannot be rescued by the saved quote or cached native identity', async () => {
  let now = NOW;
  const q = quote('hyperliquid'), f = fixture(q), clients = createPublicClients({ fetcher: f.fetcher, clock: () => now });
  await clients.loadDepth(q); now += 300_001; f.binance.symbols[0].underlyingType = 'STOCK';
  await assert.rejects(clients.loadDepth(q), /独立 Binance COIN/);
  assert.equal(f.requests.filter(r => r.url.endsWith('/exchangeInfo')).length, 2);
  assert.equal(f.requests.filter(r => r.init.body && JSON.parse(r.init.body).type === 'l2Book').length, 1);
});

test('legitimate crypto categories and independently listed native Hyperliquid assets stay available', async () => {
  for (const subtypes of [[], ['PoW', 'Crypto'], ['DeFi', 'Layer-1']]) {
    const q = quote('binance'), f = fixture(q); f.binance.symbols[0].underlyingSubType = subtypes;
    assert.ok((await createPublicClients({ fetcher: f.fetcher, clock: () => NOW }).loadDepth(q)).bids.length);
  }
  for (const contract_type of ['', 'crypto']) {
    const q = quote('gate'), f = fixture(q); f.metadata.contract_type = contract_type;
    assert.ok((await createPublicClients({ fetcher: f.fetcher, clock: () => NOW }).loadDepth(q)).bids.length);
  }
  for (const base of ['HYPE', 'PURR']) {
    const q = quote('hyperliquid', 'USDC', base), f = fixture(q); f.metadata.universe[0].szDecimals = 0;
    assert.equal((await createPublicClients({ fetcher: f.fetcher, clock: () => NOW }).loadDepth(q)).quoteCurrency, 'USDC');
  }
});
