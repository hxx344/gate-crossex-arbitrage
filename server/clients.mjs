import { AppError, monitorUrl, validIdentity } from './model.mjs';
export const CATALOG_URL = 'https://api.gateio.ws/api/v4/crossex/rule/symbols';
export async function getJson(url, { headers = {}, fetcher = fetch, maxBytes = 8 * 1024 * 1024 } = {}) {
  const response = await fetcher(url, { method: 'GET', headers: { Accept: 'application/json', ...headers }, redirect: 'error', signal: AbortSignal.timeout(8000) });
  if (!response.ok) { await response.body?.cancel(); throw new AppError(response.status === 401 ? '来源认证失败，请检查价差模块登录信息' : `只读来源响应 ${response.status}`, 502); }
  const chunks = []; let length = 0;
  for await (const chunk of response.body) { length += chunk.length; if (length > maxBytes) throw new AppError('来源响应过大', 502); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new AppError('来源没有返回有效 JSON', 502); }
}
export const loadCatalog = () => getJson(CATALOG_URL);
export const loadFeed = (config, password) => getJson(`${monitorUrl(config.monitorUrl)}/api/monitors/perpetual/opportunities`, { headers: password ? { Authorization: `Basic ${Buffer.from(`${config.monitorUsername}:${password}`).toString('base64')}` } : {} });
export async function loadDepth(quote) {
  if (!validIdentity(quote)) throw new AppError('不支持的深度合约');
  const symbol = encodeURIComponent(quote.symbol);
  if (quote.exchange === 'binance') {
    const data = await getJson(`https://fapi.binance.com/fapi/v1/depth?symbol=${symbol}&limit=100`);
    return { at: Number(data.T), bids: data.bids?.map(x => x.map(Number)), asks: data.asks?.map(x => x.map(Number)) };
  }
  const data = await getJson(`https://api.bybit.com/v5/market/orderbook?category=linear&symbol=${symbol}&limit=50`);
  if (data.retCode !== 0 || data.result?.s !== quote.symbol) throw new AppError('Bybit 深度响应无效', 502);
  return { at: Number(data.result.cts ?? data.result.ts), bids: data.result.b?.map(x => x.map(Number)), asks: data.result.a?.map(x => x.map(Number)) };
}
