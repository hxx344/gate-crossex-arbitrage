import { useEffect, useState } from 'react';
import type { Instrument, MarketData } from './live-types';

export function useInstruments(active: boolean) {
  const [items, setItems] = useState<Instrument[]>([]), [error, setError] = useState('');
  useEffect(() => {
    if (!active) return;
    const abort = new AbortController();
    void fetch('/api/live/instruments', { signal: abort.signal, cache: 'no-store' }).then(async response => {
      const data = await response.json(); if (!response.ok) throw new Error(data.error || '合约目录暂不可用');
      if (!Array.isArray(data.items)) throw new Error('合约目录格式不可用');
      setItems(data.items); setError('');
    }).catch(cause => { if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : '合约目录读取失败'); });
    return () => abort.abort();
  }, [active]);
  return { items, error };
}

/** Read only while the visible route needs the symbol; a new symbol never displays the old symbol's book. */
export function useMarket(symbol: string, interval: string, active: boolean) {
  const [data, setData] = useState<MarketData | null>(null), [error, setError] = useState('');
  useEffect(() => {
    setData(null); setError('');
    if (!symbol || !active) return;
    let epoch = 0, disposed = false, timer: ReturnType<typeof setTimeout> | undefined, abort: AbortController | undefined;
    const synchronize = () => {
      const version = ++epoch; clearTimeout(timer); abort?.abort();
      if (document.hidden || disposed) return;
      const poll = async () => {
        if (version !== epoch || disposed) return;
        abort = new AbortController(); const request = abort; const started = performance.now();
        try {
          const response = await fetch(`/api/live/market?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}`, { signal: AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]), cache: 'no-store' });
          const next = await response.json(); if (!response.ok) throw new Error(next.error || '行情读取失败');
          if (next.symbol !== symbol) throw new Error('行情合约不匹配');
          if (version === epoch && !disposed) { setData(next); setError(''); }
        } catch (cause) {
          if (!request.signal.aborted && version === epoch && !disposed) {
            setError(cause instanceof Error ? cause.message : '行情连接中断'); setData(previous => previous ? { ...previous, status: 'stale' } : null);
          }
        } finally { if (version === epoch && !disposed) timer = setTimeout(poll, Math.max(0, 2000 - (performance.now() - started))); }
      };
      void poll();
    };
    synchronize(); document.addEventListener('visibilitychange', synchronize);
    return () => { disposed = true; epoch++; clearTimeout(timer); abort?.abort(); document.removeEventListener('visibilitychange', synchronize); };
  }, [symbol, interval, active]);
  return { data: data?.symbol === symbol && data.interval === interval ? data : null, error };
}
