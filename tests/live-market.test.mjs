import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../server/store.mjs';
import { createMarket } from '../server/market.mjs';
import { feed, quote, book, catalog, epoch } from './fixtures.mjs';

function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'crossex-live-market-'));
  const store = createStore(directory);
  let now = epoch, current = feed(now), rules = catalog.map(r => ({ ...r, max_limit_size: '10000' }));
  let depth = q => book(q, now), offline = false, identities = 0;
  const market = createMarket(store, { clock: () => now, feedReader: async () => { if (offline) throw new Error('unavailable'); return current; },
    catalogReader: async () => rules, depthReader: q => depth(q), identityReader: async symbol => { identities++; return quote(symbol.startsWith('BINANCE') ? 'binance' : 'bybit', now); }, ...options });
  t.after(async () => { await market.stop(); store.close(); assert.ok(directory.startsWith(join(tmpdir(), 'crossex-live-market-'))); rmSync(directory, { recursive: true, force: true }); });
  return { store, market, get identities() { return identities; }, setFeed(x) { current = x; }, setRules(x) { rules = x; }, setDepth(fn) { depth = fn; }, offline() { offline = true; }, advance(ms) { now += ms; current = feed(now); }, now: () => now };
}

test('manual market never uses saved paper positions or enabled automation', async t => {
  const f = fixture(t);
  f.store.set('config', { enabled: true, executionMode: 'staged' });
  await f.market.refresh();
  const view = f.market.view();
  assert.equal(view.config.enabled, undefined); assert.equal(view.config.executionMode, undefined);
  assert.equal(view.positions, undefined); assert.equal(f.store.positions().length, 0); assert.equal(f.store.executions().length, 0);
  assert.throws(() => f.market.settings({ config: { enabled: true } }), /手动交易/);
  assert.throws(() => f.market.settings({ config: { executionScenario: 'normal' } }), /手动交易/);
  assert.equal(f.market.view().opportunities.length, 1);
});

test('preview returns exact paired LIMIT quantities and never writes a fill', async t => {
  const f = fixture(t), plan = await f.market.previewOpen(`signal-${epoch}`);
  assert.equal(plan.kind, 'open'); assert.equal(plan.legs.length, 2);
  assert.equal(plan.legs[0].quantity, plan.legs[1].quantity);
  assert.equal(typeof plan.legs[0].quantity, 'string'); assert.equal(typeof plan.legs[0].price, 'string');
  assert.equal(plan.legs[0].side, 'BUY'); assert.equal(plan.legs[1].side, 'SELL');
  assert.ok(Number(plan.legs[0].notionalUSDT) <= 100); assert.ok(Number(plan.legs[1].notionalUSDT) <= 100);
  assert.equal(f.store.positions().length, 0); assert.equal(f.store.executions().length, 0);
  assert.ok(await f.market.revalidateOpen(plan));
  f.advance(1000); // A fresh signal version with the same identity is valid.
  assert.ok(await f.market.revalidateOpen(plan));
});

test('withdrawn opportunity, price movement, and changed settings invalidate confirmation', async t => {
  const f = fixture(t), plan = await f.market.previewOpen(`signal-${epoch}`);
  f.setFeed({ ...feed(epoch), signals: [] });
  await assert.rejects(f.market.revalidateOpen(plan), /撤回/);
  f.setFeed(feed(epoch));
  f.setDepth(q => ({ ...book(q, epoch), asks: [[q.ask + 2, 100]] }));
  await assert.rejects(f.market.revalidateOpen(plan), /价格限制/);
  f.setDepth(q => book(q, epoch));
  f.market.settings({ config: { slippageBps: 6 } });
  await assert.rejects(f.market.revalidateOpen(plan), /设置/);
});

test('new-entry pause and Monitor failure do not prevent independent reduce-only close previews', async t => {
  const f = fixture(t); f.offline(); f.market.settings({ config: { entryPaused: true } });
  const plan = await f.market.previewClose({ symbol: 'BINANCE_FUTURE_BTC_USDT', position_side: 'LONG', position_qty: '1' }, '0.25');
  assert.equal(f.identities, 1); assert.equal(plan.kind, 'close'); assert.equal(plan.legs[0].side, 'SELL');
  assert.equal(plan.legs[0].quantity, '0.25'); assert.equal(plan.legs[0].reduceOnly, true);
  await f.market.revalidateClose(plan);
  const short = await f.market.previewClose({ symbol: 'BYBIT_FUTURE_BTC_USDT', position_side: 'SHORT', position_qty: '-1' });
  assert.equal(short.legs[0].side, 'BUY'); assert.equal(short.legs[0].quantity, '1');
  await assert.rejects(f.market.previewClose({ symbol: 'BINANCE_FUTURE_BTC_USDT', position_side: 'LONG', position_qty: '1' }, '1.1'), /不超过/);
  await assert.rejects(f.market.previewClose({ symbol: 'BINANCE_FUTURE_BTC_USDT', position_side: 'LONG', position_qty: '1' }, '0.2501'), /步长/);
});

test('LIMIT-specific size rule must be known or explicitly absent', async t => {
  const f = fixture(t); f.setRules(catalog);
  await assert.rejects(f.market.previewOpen(`signal-${epoch}`), /最大限价数量/);
});

test('explicit null limit is disclosed, quantity step stays exact and old quotes cannot authorize entry', async t => {
  const f = fixture(t); f.setRules(catalog.map(r => ({ ...r, max_limit_size: null, lot_size: '0.0000000001' })));
  const plan = await f.market.previewOpen(`signal-${epoch}`);
  assert.ok(plan.warnings.some(x => x.includes('最大限价数量')));
  assert.equal(f.store.positions().length, 0);
  f.advance(11000); f.setFeed(feed(epoch));
  await assert.rejects(f.market.revalidateOpen(plan), /过期/);
});

test('slow source response is discarded after a connection change', async t => {
  let done;
  const f = fixture(t, { feedReader: () => new Promise(resolve => { done = resolve; }) });
  const pending = f.market.refreshSource();
  f.market.settings({ config: { monitorUsername: 'replacement' } }); done(feed(epoch)); await pending;
  assert.equal(f.market.view().source.updatedAt, null); assert.equal(f.market.view().opportunities.length, 0);
});

test('Hyperliquid limits obey five significant figures as well as Gate ticks', async t => {
  const q = { ...quote('hyperliquid'), symbol: 'BTC', crossexSymbol: 'HYPERLIQUID_FUTURE_BTC_USDC',
    counterCurrency: 'USDC', settlementCurrency: 'USDC', collateralCurrency: 'USDC', contractKind: 'quanto', bid: 1234.5, ask: 1234.6 };
  const f = fixture(t, { identityReader: async () => q, fxReader: async () => ({ baseCurrency: 'USDT', staleAfterMs: 180000, rates: { USDC: { bid: 1, ask: 1, at: epoch, source: 'isolated-test' } } }) });
  f.setRules([{ ...catalog[0], exchange_type: 'HYPERLIQUID', symbol: q.crossexSymbol, tick_size: '0.01', max_limit_size: null }]);
  const p = await f.market.previewClose({ symbol: q.crossexSymbol, position_side: 'LONG', position_qty: '1' });
  assert.equal(p.legs[0].price, '1233.9');
  await f.market.revalidateClose(p);
});

test('missing conversion cannot block a native reduce-only close but blocks new exposure totals', async t => {
  const q = { ...quote('bybit'), symbol: 'BTCPERP', quoteCurrency: 'USDC', settlementCurrency: 'USDC', collateralCurrency: 'USDC', counterCurrency: 'USDC', crossexSymbol: 'BYBIT_FUTURE_BTC_USDC', contractKind: 'linear' };
  const f = fixture(t, { identityReader: async () => q, fxReader: async () => { throw new Error('fx offline'); } });
  f.setRules([{ ...catalog[1], symbol: q.crossexSymbol, max_limit_size: '10000' }]);
  const plan = await f.market.previewClose({ symbol: q.crossexSymbol, position_side: 'SHORT', position_qty: '1' });
  assert.equal(plan.legs[0].notionalUSDT, null);
  await f.market.revalidateClose(plan);
  await assert.rejects(f.market.positionsNotional([{ symbol: q.crossexSymbol, position_qty: '1', mark_price: '100' }]));
});

test('manual tickets and equal-base pairs work independently of Monitor and never bypass precision or budget', async t => {
  const f = fixture(t); f.offline();
  const input = { symbol: 'BINANCE_FUTURE_BTC_USDT', side: 'BUY', quantity: '0.25', orderType: 'LIMIT', price: '98', timeInForce: 'GTC' };
  const plan = await f.market.previewDirect(input);
  assert.equal(plan.source, 'direct'); assert.equal(plan.legs[0].price, '98');
  await f.market.revalidateOpen(plan);
  const pair = await f.market.previewPair({ longSymbol: input.symbol, shortSymbol: 'BYBIT_FUTURE_BTC_USDT', quantity: '0.25' });
  assert.equal(pair.source, 'pair'); assert.equal(pair.legs[0].quantity, pair.legs[1].quantity);
  assert.equal(pair.legs[1].side, 'SELL'); await f.market.revalidateOpen(pair);
  await assert.rejects(f.market.previewPair({ longSymbol: input.symbol, shortSymbol: input.symbol, quantity: '0.25' }), /不同交易所/);
  await assert.rejects(f.market.previewDirect({ ...input, quantity: '0.2501' }), /步长/);
  await assert.rejects(f.market.previewDirect({ ...input, quantity: '2' }), /预算/);
  await assert.rejects(f.market.previewDirect({ ...input, price: '98.001' }), /精度/);
  await assert.rejects(f.market.previewDirect({ ...input, quantity: 0.25 }), /无效/);
  f.market.settings({ config: { entryPaused: true } });
  await assert.rejects(f.market.revalidateOpen(plan), /设置/);
});

test('market tickets honor their own size cap and require current fillable depth', async t => {
  const f = fixture(t);
  f.setRules(catalog.map(r => ({ ...r, max_market_size: '0.1', max_limit_size: '10000' })));
  const input = { symbol: 'BINANCE_FUTURE_BTC_USDT', side: 'BUY', quantity: '0.25', orderType: 'MARKET', timeInForce: 'IOC' };
  await assert.rejects(f.market.previewDirect(input), /单笔上限/);
  const p = await f.market.previewDirect({ ...input, quantity: '0.1' });
  assert.equal(p.legs[0].orderType, 'MARKET'); assert.ok(p.warnings.some(w => w.includes('不是最终成交')));
  await assert.rejects(f.market.previewDirect({ ...input, quantity: '0.1', price: '100' }), /无效/);
  f.setDepth(q => ({ ...book(q, epoch), asks: [[200, 100]] }));
  await assert.rejects(f.market.revalidateOpen(p), /深度不足/);
});

test('confirmation cannot raise a reviewed margin or risk valuation even below the single-leg budget', async t => {
  const f = fixture(t); f.market.settings({ config: { notionalPerLeg: 200 } });
  const plan = await f.market.previewDirect({ symbol: 'BINANCE_FUTURE_BTC_USDT', side: 'SELL', quantity: '1', orderType: 'LIMIT', price: '90', timeInForce: 'GTC' });
  f.setDepth(q => ({ ...book(q, epoch), bids: [[110, 100]], asks: [[111, 100]] }));
  await assert.rejects(f.market.revalidateOpen(plan), /提高订单估值/);
});

test('confirmation rechecks FX against the exact previewed USDT valuation', async t => {
  let rate = 1;
  const q = { ...quote('bybit'), symbol: 'BTCPERP', quoteCurrency: 'USDC', settlementCurrency: 'USDC', collateralCurrency: 'USDC', counterCurrency: 'USDC', crossexSymbol: 'BYBIT_FUTURE_BTC_USDC', contractKind: 'linear' };
  const f = fixture(t, { identityReader: async () => q, fxReader: async () => ({ baseCurrency: 'USDT', staleAfterMs: 180000, rates: { USDC: { bid: rate, ask: rate, at: epoch, source: 'isolated-test' } } }) });
  f.setRules([{ ...catalog[1], symbol: q.crossexSymbol, max_limit_size: '10000' }]);
  const plan = await f.market.previewDirect({ symbol: q.crossexSymbol, side: 'BUY', quantity: '0.1', orderType: 'LIMIT', price: '100', timeInForce: 'GTC' });
  rate = 1.01;
  await assert.rejects(f.market.revalidateOpen(plan), /提高订单估值/);
  rate = 0.99;
  await f.market.revalidateOpen(plan);
});
