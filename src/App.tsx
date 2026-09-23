import { createLatestRead } from './latest-read';
import { createServerClock, sourceIsStale, valuationStaleReason, opportunityStaleReason, STATE_POLL_MS } from './freshness';
import { useHubBridge, hubChanged, hubNavigate, cleanHubQuery } from './hub-bridge';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeftRight, RefreshCw, Play, Pause, Settings, Radio, CheckCircle2, AlertCircle } from 'lucide-react';
import type { Opportunity, State } from './types';
import { direction, format, signedClass, stateLabel, time, venue, venues } from './display';
import SettingsForm from './SettingsForm';
import PositionsPanel from './PositionsPanel';
import HistoryPanel from './HistoryPanel';

type Tab = 'opportunities' | 'positions' | 'history' | 'settings';
const tabs: [Tab, string][] = [['opportunities', '发现机会'], ['positions', '模拟持仓'], ['history', '记录与收益'], ['settings', '连接与设置']];

export default function App() {
  const hub = useHubBridge('crossex');
  const [state, setState] = useState<State | null>(null), [error, setError] = useState(''), [readError, setReadError] = useState(''), [busy, setBusy] = useState(false), [online, setOnline] = useState(false);
  const [tab, setTab] = useState<Tab>(() => tabs.some(x => x[0] === location.hash.slice(1)) ? location.hash.slice(1) as Tab : 'opportunities');
  const [selectedVenue, setSelectedVenue] = useState('');
  const [pair, setPair] = useState<{ longExchange?: string; shortExchange?: string }>({});
  const [search, setSearch] = useState(''), [showAll, setShowAll] = useState(false), [now, setNow] = useState(Date.now());
  const requests = useRef(new Map<string, string>());
  const lifecycle = useRef({ active: hub.active, tab, mutating: false, historyVersion: '' });
  lifecycle.current.active = hub.active; lifecycle.current.tab = tab;
  const serverClock = useRef(createServerClock());
  const reader = useRef<ReturnType<typeof createLatestRead<State & { historyVersion?: string; requestStartedAt: number }>> | null>(null);
  if (!reader.current) reader.current = createLatestRead({
    canRead: () => lifecycle.current.active && !document.hidden && !lifecycle.current.mutating,
    load: async signal => {
      const current = lifecycle.current, params = new URLSearchParams({ history: current.tab === 'history' ? '1' : '0' });
      if (current.historyVersion) params.set('historyVersion', current.historyVersion);
      const requestStartedAt = performance.now();
      const res = await fetch('/api/state?' + params, { signal, cache: 'no-store' }), data = await res.json();
      if (!res.ok) throw new Error(data.error); return { ...data, requestStartedAt };
    },
    onData: ({ requestStartedAt, ...data }) => {
      serverClock.current.sample(data.now, requestStartedAt);
      if (data.historyVersion) lifecycle.current.historyVersion = data.historyVersion;
      setState(previous => ({ ...data, history: data.history ?? previous?.history ?? [], events: data.events ?? previous?.events ?? [], analytics: data.analytics ?? previous?.analytics, executions: data.executions ?? [] })); setOnline(true); setReadError(''); setNow(serverClock.current.now());
    },
    onError: e => { setOnline(false); setReadError(e instanceof Error ? e.name === 'TimeoutError' ? '读取状态超时，正在自动重试' : e.message : '模块连接失败，正在自动重试'); },
  });
  const cancelRead = useCallback(() => reader.current?.cancel(), []);
  const refresh = useCallback((force = false) => reader.current!.refresh(force), []);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined, epoch = 0, stopped = false;
    const synchronize = () => {
      const version = ++epoch; clearTimeout(timer); cancelRead();
      if (!hub.active || document.hidden || stopped) return;
      const poll = async () => { if (version !== epoch || stopped) return; const startedAt = performance.now(); await refresh(); if (version === epoch && !stopped) timer = setTimeout(poll, Math.max(0, STATE_POLL_MS - (performance.now() - startedAt))); };
      void poll();
    };
    const ageTimer = setInterval(() => { if (hub.active && !document.hidden) setNow(serverClock.current.now()); }, 1000);
    synchronize(); document.addEventListener('visibilitychange', synchronize);
    return () => { stopped = true; epoch++; clearTimeout(timer); clearInterval(ageTimer); cancelRead(); document.removeEventListener('visibilitychange', synchronize); };
  }, [hub.active, tab, refresh, cancelRead]);
  useEffect(() => {
    const restore = () => {
      const params = new URL(location.href).searchParams;
      const query = cleanHubQuery(Object.fromEntries(['symbol', 'longExchange', 'shortExchange'].flatMap(key => params.has(key) ? [[key, params.get(key)!]] : [])));
      if (!query) return;
      setSearch(query.symbol || ''); setPair({ longExchange: query.longExchange, shortExchange: query.shortExchange });
      if (Object.keys(query).length) { setShowAll(true); setTab('opportunities'); }
    };
    restore(); addEventListener('popstate', restore); return () => removeEventListener('popstate', restore);
  }, []);
  useEffect(() => { const change = () => { const hash = location.hash.slice(1); if (tabs.some(x => x[0] === hash)) setTab(hash as Tab); }; addEventListener('hashchange', change); return () => removeEventListener('hashchange', change); }, []);
  async function mutate(route: string, input: object, method = 'POST', actionKey?: string) {
    if (!state || lifecycle.current.mutating) return;
    lifecycle.current.mutating = true; cancelRead();
    setBusy(true); setError('');
    try {
      if (actionKey && !requests.current.has(actionKey)) {
        const id = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(24)), n => n.toString(16).padStart(2, '0')).join('');
        requests.current.set(actionKey, id);
      }
      const res = await fetch(route, { method, signal: AbortSignal.timeout(30_000), headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrfToken }, body: JSON.stringify({ ...input, ...(actionKey ? { requestId: requests.current.get(actionKey) } : {}) }) });
      const data = await res.json(); if (!res.ok) throw new Error(data.error);
      if (actionKey) requests.current.delete(actionKey); hubChanged(); lifecycle.current.mutating = false; await refresh(true); return true;
    } catch (e) { setError(e instanceof Error ? e.message : '响应未确认，可重试相同操作；成功的请求不会重复记账'); return false; }
    finally { lifecycle.current.mutating = false; setBusy(false); }
  }
  const go = (value: Tab) => { setTab(value); location.hash = value; setError(''); };
  const stale = sourceIsStale(state?.source, now, online);
  const stalePositions = state?.positions.filter(p => valuationStaleReason(p.valuation, now, stale)).length || 0;
  const rows = state?.opportunities.filter(x => (showAll || (x.eligible && !opportunityStaleReason(x, now))) && (!selectedVenue || [x.long.exchange, x.short.exchange].includes(selectedVenue)) && (!pair.longExchange || x.long.exchange === pair.longExchange) && (!pair.shortExchange || x.short.exchange === pair.shortExchange) && x.base.includes(search.trim().toUpperCase())) || [];
  const activeExecutions = state?.totals.activeExecutions || 0;
  const enabled = !!state?.config.enabled, entryPaused = !!state?.config.entryPaused;
  const statusText = !enabled ? '全部自动已暂停' : entryPaused ? '新仓已暂停 · 继续退出管理' : stale ? '自动模拟等待行情' : '自动模拟运行中';
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-icon"><ArrowLeftRight size={25}/></span>
          <div><h1>Gate CrossEx <span className="tag">模拟</span></h1><p>永续价差 · 发现到执行</p></div>
        </div>
        <div className="header-actions">
          {hub.connected && <button onClick={() => hubNavigate('monitor', {
            ...(search.trim() ? { symbol: search.trim().toUpperCase() } : {}),
            ...(pair.longExchange ? { longExchange: pair.longExchange } : {}),
            ...(pair.shortExchange ? { shortExchange: pair.shortExchange } : {}),
          })}>在 Monitor 查看</button>}
          <button disabled={busy} onClick={() => { setError(''); void refresh(); }} aria-label="刷新模块"><RefreshCw size={16}/><span>刷新</span></button>
          <button disabled={!state || busy || !online} onClick={() => void mutate('/api/settings', { config: { entryPaused: !entryPaused } }, 'PUT')}>
            {entryPaused ? <Play size={16}/> : <Pause size={16}/>} {entryPaused ? '允许新仓' : '只暂停新仓'}
          </button>
          <button className={enabled ? '' : 'primary'} disabled={!state || busy || !online} onClick={() => void mutate('/api/settings', { config: { enabled: !enabled } }, 'PUT')}>
            {enabled ? <Pause size={16}/> : <Play size={16}/>} {enabled ? '暂停全部自动' : '启动自动模拟'}
          </button>
        </div>
      </header>
      <nav aria-label="模块功能">{tabs.map(([id, label]) => (
        <button key={id} aria-current={tab === id ? 'page' : undefined} onClick={() => go(id)}>
          {label}
          {id === 'positions' && !!state && !!(state.totals.openCount + activeExecutions) && <span className="count">{state.totals.openCount} 仓{activeExecutions ? ' / ' + activeExecutions + ' 任务' : ''}</span>}
        </button>
      ))}</nav>
      <main>
        <div className="context-line">
          <span><span className={'status-dot ' + (enabled && !stale ? 'live' : '')}/>{statusText}</span>
          <span>仅模拟记账 · 不发送真实订单</span><span>北京时间</span>
        </div>
        {(error || readError) && <div role="alert" className="notice error"><AlertCircle size={18}/><span>{error || readError}</span><button onClick={() => { setError(''); setReadError(''); }} aria-label="关闭提示">×</button></div>}
        {!state ? <div className="empty panel">正在读取模块状态…</div> : <>
          <section className="metrics expanded-metrics" aria-label="模拟概览">
            <Metric label="累计模拟净值" value={format(stalePositions ? null : state.totals.netWithFunding)} unit="USDT"
              detail={stalePositions ? stalePositions + ' 组估值过期，完整净值暂不可用' : state.totals.fundingComplete ? '已实现 + 浮盈 + 已确认资金费' : '资金费未完整确认，保留缺失值'} signed={state.totals.netWithFunding}/>
            <Metric label="已实现价差盈亏" value={format(state.totals.realizedPnl)} unit="USDT" detail={'已扣手续费 · 含资金费 ' + format(state.totals.realizedWithFunding) + ' USDT'} signed={state.totals.realizedPnl}/>
            <Metric label="BBO 参考浮盈" value={format(stalePositions ? null : state.totals.unrealizedPnl)} unit="USDT"
              detail={stalePositions ? stalePositions + ' 组估值过期' : '不含资金费 · 平仓还需逐档复核'} signed={state.totals.unrealizedPnl}/>
            <Metric label="模拟持仓 / 任务" value={String(state.totals.openCount)} unit={'/ ' + state.config.maxOpen + ' 组'}
              detail={'占用 ' + format(state.totals.usedNotional) + ' · 预留 ' + format(state.totals.reservedNotional ?? 0) + ' USDT · ' + activeExecutions + ' 个执行任务'}/>
          </section>
          {activeExecutions > 0 && tab !== 'positions' && <div className="execution-banner"><span>{activeExecutions} 个分阶段任务待完成，已知资金费合计 {format(state.totals.fundingKnown, 4)} USDT</span><button className="text-button" onClick={() => go('positions')}>查看执行与暴露</button></div>}
          <section className="connections" aria-label="数据来源">
            <div><Radio size={18}/><span><strong>Market Monitor</strong><span className={stale ? 'warning' : 'positive'}>{stale ? stateLabel(['live', 'partial'].includes(state.source.state) ? 'stale' : state.source.state) : stateLabel(state.source.state)}</span>
              <small>行情源时间 {time(state.source.updatedAt)}</small>
              <small>最近读取成功 {time(state.source.receivedAt)}{state.source.durationMs != null && ' · 请求耗时 ' + format(state.source.durationMs / 1000, 2) + ' 秒'}</small>
            </span></div>
            <div><CheckCircle2 size={18}/><span><strong>CrossEx 合约目录</strong><span className={state.catalog.state === 'live' ? 'positive' : 'warning'}>{stateLabel(state.catalog.state)}</span><small>核对时间 {time(state.catalog.updatedAt)}</small></span></div>
            {(state.source.error || state.catalog.error) && <p className="connection-error">{state.source.error || state.catalog.error}<button className="text-button" onClick={() => go('settings')}>检查连接 <Settings size={13}/></button></p>}
          </section>
          <section className="coverage" aria-label="交易所与汇率">
            <div className="venue-strip">{state.venues?.map(item => <span key={item.id}><strong>{venue(item.id)}</strong><small className={item.state === 'live' ? 'positive' : 'warning'}>{stateLabel(item.state)} · {item.quoteCount} 个合约</small></span>)}</div>
            <div className="fx-strip">{state.fx?.map(item => <span key={item.currency}>{item.currency} / USDT {item.state === 'live' ? format(item.bid, 6) + ' / ' + format(item.ask, 6) + ' · ' + time(item.at) : '汇率待更新，该币种暂不模拟'}</span>)}</div>
          </section>
          {tab === 'opportunities' && <section className="panel">
            <div className="section-heading">
              <div><h2>同币种，跨所价差</h2><p>七所永续 · 统一折算 USDT · {state.opportunities.filter(x => x.eligible && !opportunityStaleReason(x, now)).length} 个候选通过初筛</p></div>
              <div className="filters">
                {(pair.longExchange || pair.shortExchange) && <button onClick={() => { setPair({}); const url = new URL(location.href); url.searchParams.delete('longExchange'); url.searchParams.delete('shortExchange'); history.replaceState(null, '', url); }}>清除方向限定</button>}
                <select aria-label="筛选交易所" value={selectedVenue} onChange={e => setSelectedVenue(e.target.value)}><option value="">全部交易所</option>{Object.entries(venues).map(([id, name]) => <option value={id} key={id}>{name}</option>)}</select>
                <input aria-label="搜索币种" placeholder="搜索币种" value={search} onChange={e => setSearch(e.target.value)}/>
                <label className="check"><input type="checkbox" checked={showAll} onChange={e => setShowAll(e.target.checked)}/>显示未通过机会</label>
              </div>
            </div>
            {entryPaused && <div className="inline-state warning" role="status">新仓已暂停；允许新仓后可继续手动或自动开仓，已有持仓仍按当前自动开关管理。</div>}
            <div className="inline-state" role="status">{state.source.entryPolicy?.requireSpotTransfer === true ? 'Monitor 已开启：双边有可交易现货、共同网络双向充提正常' : state.source.entryPolicy?.requireSpotTransfer === false ? 'Monitor 现货与充提筛选未启用，当前机会不代表已核验充提' : 'Monitor 未提供现货与充提策略，资格未核验'}{state.source.entryPolicy && ` · 本次排除 ${state.source.entryPolicy.excluded} 个组合 · 屏蔽 ${state.source.entryPolicy.blockedBases.length} 个币种`}</div>
            <div className="table-wrap"><table>
              <thead><tr><th>币种 / 方向</th><th>多腿卖一 / 空腿买一</th><th>折算毛价差</th><th>预算净价差</th><th>检查结果</th><th>操作</th></tr></thead>
              <tbody>{rows.slice(0, 100).map(row => <OpportunityRow key={row.pairKey} row={row} now={now} staged={state.config.executionMode === 'staged'} disabled={busy || stale || entryPaused}
                monitor={hub.connected ? () => hubNavigate('monitor', { symbol: row.base, longExchange: row.long.exchange, shortExchange: row.short.exchange }) : undefined}
                open={() => void mutate('/api/open', { signalId: row.id }, 'POST', 'open:' + row.id)}/>)}</tbody>
            </table></div>
            {!rows.length && <div className="empty"><ArrowLeftRight size={28}/><h3>{stale ? '等待价差模块的实时信号' : state.source.entryPolicy?.requireSpotTransfer ? '现货与充提筛选后暂无符合条件的机会' : '暂时没有达到阈值的机会'}</h3><p>{stale ? '在连接与设置中填写同机价差服务的登录信息。' : state.source.entryPolicy?.requireSpotTransfer ? '新机会须通过双边现货、共同网络与充提核验；已有持仓可继续管理。' : '可显示未通过机会查看原因，或在设置里调整模拟参数。'}</p></div>}
            <div className="footnote">盘口价格保留原计价币；价差按双边汇率折算 USDT。预算净价差扣除多空双腿开仓与退出四次费率及四次滑点预算，资金费单独核算。当前为{state.config.executionMode === 'staged' ? '分阶段模拟，开仓后在“模拟持仓”跟踪订单与修复' : '双腿原子模拟，全量可成交后才记账'}。</div>
          </section>}
          {tab === 'positions' && <PositionsPanel state={state} now={now} stale={stale} online={online} busy={busy}
            close={id => void mutate('/api/close', { positionId: id }, 'POST', 'close:' + id)}
            executionAction={(id, action) => void mutate('/api/execution', { executionId: id, action }, 'POST', 'execution:' + action + ':' + id)}/>}
          {tab === 'history' && <HistoryPanel state={state} online={online}/>}
          {tab === 'settings' && <SettingsForm config={state.config} busy={busy} save={value => mutate('/api/settings', value, 'PUT')}/>}
          <p className="model-note">模拟模型：原子模式复核双腿全量成交；分阶段模式记录分批、单腿暴露、拒单、状态待确认和修复。均价包含逐档滑点，手续费与可确认资金费单独记账；预估和未知资金费不冒充已实现收入。未覆盖真实撮合排队、强平和完整保证金约束；同币种等量对冲仍有结算币汇率风险。无需交易所 API Key。</p>
        </>}
      </main>
    </div>
  );
}

function Metric({ label, value, unit, detail, signed }: { label: string; value: string; unit: string; detail: string; signed?: number | null }) {
  return <div className="metric"><span>{label}</span><div className={value === '—' ? '' : signedClass(signed)}><strong>{value}</strong><small>{unit}</small></div><p>{detail}</p></div>;
}

function OpportunityRow({ row, now, disabled, staged, open, monitor }: { row: Opportunity; now: number; disabled: boolean; staged: boolean; open: () => void; monitor?: () => void }) {
  const expiryReason = opportunityStaleReason(row, now);
  const eligible = row.eligible && !expiryReason;
  return <tr>
    <td><strong>{row.base}</strong><small>{direction(row)}</small></td>
    <td>{format(row.long.ask, 6)} {row.long.quoteCurrency}<small>{format(row.short.bid, 6)} {row.short.quoteCurrency}</small></td>
    <td>{format(row.grossBps)} bp</td>
    <td className={signedClass(row.netBps)}>{format(row.netBps)} bp{row.feeSnapshot && <small>往返费率 {format(row.feeSnapshot.long.entry.bps + row.feeSnapshot.long.exit.bps + row.feeSnapshot.short.entry.bps + row.feeSnapshot.short.exit.bps)} bp</small>}</td>
    <td><span className={eligible ? 'positive' : 'muted'}>{expiryReason || (row.eligible ? '待深度复核' : row.reason)}</span><small>{row.transfer?.reason || '现货与充提未核验'}</small>{row.transfer?.state === 'verified' && <><small>共同网络 {row.transfer.networks.join(' / ')} · 双向充提</small><small>核验 {time(row.transfer.checkedAt)} · 到期 {time(row.transfer.expiresAt)}</small></>}{!!row.warnings?.length && <small className="rule-note">部分目录额度未提供，仅按模拟预算复核</small>}</td>
    <td><div className="row-actions"><button className="primary" disabled={disabled || !eligible} onClick={open}>{staged ? '分阶段开仓' : '模拟开仓'}</button>{monitor && <button onClick={monitor}>在 Monitor 查看</button>}</div></td>
  </tr>;
}
