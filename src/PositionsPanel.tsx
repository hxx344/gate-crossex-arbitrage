import { direction, format, scenarioNames, signedClass, time, venue } from './display';
import { valuationStaleReason } from './freshness';
import PnlBreakdown from './PnlBreakdown';
import type { Execution, FeeSnapshot, FundingRate, Position, State } from './types';

const executionLabels: Record<Execution['state'], string> = {
  queued: '排队中', executing: '分阶段执行中', repairing: '修复双腿中', completed: '已完成',
  blocked: '待处理', cancel_pending: '等待撤销确认', cancelled: '已撤销',
};
const orderLabels: Record<string, string> = {
  pending: '等待处理', pending_submit: '等待确认', submitted: '已提交', accepted: '已接受', filled: '全部成交', partial: '部分成交',
  partially_filled: '部分成交', rejected: '已拒绝', unknown: '状态待确认', cancel_pending: '等待撤销', cancelled: '已撤销',
};
const terminal = (execution: Execution) => ['completed', 'cancelled'].includes(execution.state);
const legName = (leg: string) => leg === 'long' ? '多腿' : leg === 'short' ? '空腿' : leg;
const sideName = (side: string) => side === 'buy' ? '买入' : side === 'sell' ? '卖出' : side;

export function FeesDetail({ snapshot, fallback }: { snapshot?: FeeSnapshot; fallback: number }) {
  const rows = [
    ['多腿开仓', snapshot?.long.entry], ['空腿开仓', snapshot?.short.entry],
    ['多腿退出', snapshot?.long.exit], ['空腿退出', snapshot?.short.exit],
  ] as const;
  return (
    <details className="position-detail">
      <summary>四次成交费率快照</summary>
      <div className="table-wrap"><table>
        <thead><tr><th>成交环节</th><th>费率</th><th>来源</th><th>配置更新时间</th></tr></thead>
          <tbody>{rows.map(([label, rate]) => <tr key={label}><td>{label}</td><td>{format(rate?.bps ?? fallback)} bp</td><td>{rate?.source === 'legacy-feeBps' ? '默认模拟费率' : rate?.source || '旧持仓默认费率'}</td><td>{rate ? time(rate.updatedAt) : '旧记录未保存时间'}</td></tr>)}</tbody>
      </table></div>
      <p className="detail-note">费率按开仓时快照保留；逐档成交均价已包含滑点，手续费单独记账。</p>
    </details>
  );
}

function FundingLeg({ title, rate }: { title: string; rate: FundingRate | null | undefined }) {
  const native = rate?.rate == null ? null : Number(rate.rate);
  const interval = rate?.intervalHours == null ? null : Number(rate.intervalHours);
  const hourlyBps = native !== null && Number.isFinite(native) && interval !== null && Number.isFinite(interval) && interval > 0 ? native * 10000 / interval : null;
  return <div>
    <dt>{title} 当前周期资金费率</dt>
    <dd>{native == null || !Number.isFinite(native) ? '未知' : `${format(native * 100, 6)}%`}{interval != null && ` / ${format(interval, 1)} 小时`}</dd>
    <small>{hourlyBps == null ? '周期未知，暂不折算比较费率' : `折合 ${format(hourlyBps, 4)} bp/小时 · ${format(hourlyBps * 8, 4)} bp/8小时（仅比较口径）`}</small>
    <small>下一结算 {time(rate?.nextFundingAt)}</small><small>来源时间 {time(rate?.sourceAt)}</small>
  </div>;
}

function PositionCard({ p, staleReason, now, online, disabled, close }: {
  p: Position; staleReason: string; now: number; online: boolean; disabled: boolean; close: () => void;
}) {
  const funding = p.funding, exit = p.exitQuote;
  const fundingLabel = funding ? { complete: '结算记录完整', partial: '部分结算已知', unknown: '结算待确认', legacy: '旧持仓未记录资金费' }[funding.status] : '资金费尚未记录';
  const exitStale = !online || !exit || exit.stale || !exit.sourceAt || now - exit.sourceAt > 10000 || exit.sourceAt > now + 1000;
  const longQuantity = p.longQuantity ?? p.quantity, shortQuantity = p.shortQuantity ?? p.quantity;
  return (
    <article className="position">
      <div className="position-title">
        <div><h3>{p.base} <span className="tag">模拟持仓</span></h3><p>{direction(p)}</p></div>
        <button onClick={close} disabled={disabled}>模拟平仓</button>
      </div>
      <dl className="position-overview">
        <div><dt>多腿 / 空腿基础币数量</dt><dd>{format(longQuantity, 8)} / {format(shortQuantity, 8)}</dd>{Number(longQuantity) !== Number(shortQuantity) && <small className="warning">双腿数量尚未对齐</small>}</div>
        <div><dt>多腿 / 空腿开仓均价</dt><dd>{format(p.longFill.price, 6)} {p.long.quoteCurrency} / {format(p.shortFill.price, 6)} {p.short.quoteCurrency}</dd></div>
        <div><dt>BBO 参考盈亏 · 不含资金费</dt><dd className={staleReason ? 'warning' : signedClass(p.valuation.net)}>{format(p.valuation.net, 4)} USDT{staleReason && ' · 旧估值'}</dd></div>
        <div><dt>BBO 参考盈亏 · 含确认资金费</dt><dd className={staleReason ? 'warning' : signedClass(p.valuation.netWithFunding)}>{format(p.valuation.netWithFunding, 4)} USDT</dd><small>{p.valuation.netWithFunding == null ? '资金费或行情未完整确认' : '仍需逐档深度复核'}</small></div>
      </dl>
      <p className="detail-note">开仓 {time(p.openedAt)} · BBO 估值 {time(p.valuation.at)}</p>
      {staleReason && <p className="settlement-note warning">{staleReason}{p.valuation.quoteTimes && <><br/>多腿盘口 {time(p.valuation.quoteTimes.long)} · 空腿盘口 {time(p.valuation.quoteTimes.short)}</>}</p>}
      <section className="exit-panel" aria-label={`${p.base} 逐档退出检查`}>
        <div className="detail-heading"><h4>逐档可退出性</h4><span className={exitStale || !exit?.complete ? 'warning' : 'positive'}>{!exit ? '等待深度复核' : exitStale ? '快照过期，等待复核' : exit.complete ? '快照内双腿均可退出' : '当前深度不足以全量退出'}</span></div>
        <dl>
          <div><dt>多腿可退出 / 持仓数量</dt><dd>{format(exit?.longQuantity, 8)} / {format(longQuantity, 8)}</dd></div>
          <div><dt>空腿可退出 / 持仓数量</dt><dd>{format(exit?.shortQuantity, 8)} / {format(shortQuantity, 8)}</dd></div>
          <div><dt>深度盈亏 · 不含资金费</dt><dd className={exitStale ? 'muted' : signedClass(exit?.priceOnlyNet)}>{format(exit?.priceOnlyNet, 4)} USDT{exit && exitStale && ' · 旧快照'}</dd></div>
          <div><dt>深度盈亏 · 含确认资金费</dt><dd className={exitStale ? 'muted' : signedClass(exit?.net)}>{format(exit?.net, 4)} USDT</dd></div>
        </dl>
        <p className="detail-note">多腿 / 空腿滑点 {format(exit?.slippageBps?.long)} / {format(exit?.slippageBps?.short)} bp · 盘口源时间 {time(exit?.sourceAt)}</p>
        <p className="detail-note">最近复核 {time(exit?.at)}。此处是按滑点上限扫描的公开深度快照，点击平仓后仍会重新读取。</p>
        {exit?.reason && <p className="settlement-note warning">{exit.reason}</p>}
      </section>
      <details className="position-detail" open={funding?.status !== 'complete'}>
        <summary>资金费 · {fundingLabel}</summary>
        <dl>
          <div><dt>完整已确认结算</dt><dd className={signedClass(funding?.confirmed)}>{format(funding?.confirmed, 4)} USDT</dd></div>
          <div><dt>已知部分合计</dt><dd>{format(funding?.known, 4)} USDT</dd><small>缺失期间不按零补齐</small></div>
          <div><dt>持有期估算合计 · 含已知部分</dt><dd>{format(funding?.estimated, 4)} USDT</dd><small>估算不能替代完整确认值</small></div>
          <div><dt>结算检查截至</dt><dd>{time(funding?.through)}</dd></div>
          <FundingLeg title={venue(p.long.exchange)} rate={funding?.current?.long}/>
          <FundingLeg title={venue(p.short.exchange)} rate={funding?.current?.short}/>
        </dl>
        {funding?.reason && <p className="detail-note warning">{funding.reason}</p>}
        <p className="detail-note">正数为模拟收取，负数为模拟支付。持有期估算包含已知金额及可估算部分；完整结算尚未确认时，含资金费净值保留缺失。</p>
      </details>
      <FeesDetail snapshot={p.feeSnapshot} fallback={p.feeBps}/>
      <PnlBreakdown value={p.valuation} entryFees={p.entryFees} funding={p.funding} staleReason={staleReason}/>
      <p className="settlement-note">结算币：多腿 {p.long.settlementCurrency || p.long.quoteCurrency} / 空腿 {p.short.settlementCurrency || p.short.quoteCurrency}；收益按结算时汇率折算 USDT</p>
      {!!p.unverifiedConstraints?.length && <details className="settlement-note"><summary>部分目录规则未提供</summary>{p.unverifiedConstraints.map(note => <p key={note}>{note}</p>)}</details>}
    </article>
  );
}

export function ExecutionPanel({ executions, now, disabled, act }: {
  executions: Execution[]; now: number; disabled: boolean;
  act: (id: string, action: 'retry' | 'cancel') => void;
}) {
  const active = executions.filter(item => !terminal(item));
  const recent = executions.filter(terminal).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 5);
  if (!executions.length) return null;
  return <section className="panel execution-panel">
    <div className="section-heading"><div><h2>分阶段执行任务 <span className="tag">{active.length} 个待完成</span></h2><p>阶段状态来自服务器；已成交数量、待确认订单与修复成本分别保留。</p></div></div>
    <div className="execution-list">{[...active, ...recent].map(item => (
      <article key={item.id} className={`execution ${item.state === 'blocked' ? 'needs-attention' : ''}`}>
        <div className="position-title">
          <div><h3>{item.base} · {item.kind === 'open' ? '开仓' : '平仓'} <span className={terminal(item) ? 'muted' : item.state === 'blocked' || item.state === 'repairing' ? 'warning' : 'positive'}>{executionLabels[item.state]}</span></h3><p>{scenarioNames[item.scenario]} · 更新 {time(item.updatedAt)}</p></div>
          {!terminal(item) && <div className="execution-actions">
            {item.state === 'blocked' && <button disabled={disabled} onClick={() => act(item.id, 'retry')}>重试 / 修复</button>}
            <button disabled={disabled || item.state === 'cancel_pending'} onClick={() => act(item.id, 'cancel')}>{item.state === 'cancel_pending' ? '撤销确认中' : '请求撤销'}</button>
          </div>}
        </div>
        <dl className="execution-metrics">
          <div><dt>目标单腿数量</dt><dd>{format(item.targetQuantity, 8)}</dd></div>
          <div><dt>当前持仓多腿 / 空腿数量</dt><dd>{format(item.longQuantity, 8)} / {format(item.shortQuantity, 8)}</dd></div>
          <div><dt>预留额度</dt><dd>{format(item.reservedNotional)} USDT</dd></div>
          <div><dt>修复成本 / 已尝试</dt><dd>{format(item.repairCost, 4)} USDT / {item.attempts} 次</dd></div>
          <div><dt>已观察最差损失</dt><dd>{format(item.worstLoss, 4)} USDT</dd><small>基于有效 BBO 采样，不含资金费</small></div>
          <div><dt>最长单腿暴露</dt><dd>{format(Math.max(item.maxUnhedgedMs ?? 0, item.unhedgedSince == null ? 0 : now - item.unhedgedSince) / 1000, 1)} 秒</dd></div>
        </dl>
        {item.unhedgedSince != null && <p className="settlement-note warning">存在未对冲暴露 · 起于 {time(item.unhedgedSince)} · 已持续 {format(Math.max(0, now - item.unhedgedSince) / 1000, 1)} 秒</p>}
        {item.error && <p className="settlement-note warning">{item.error}</p>}
        {!terminal(item) && <p className="detail-note">下一阶段 {time(item.nextAt)} · 请求撤销不等于已成交部分自动消失，以后续状态与成交记录为准。</p>}
        <details className="position-detail">
          <summary>模拟订单 {item.orderCount ?? item.orders.length} 笔 · 成交 {item.fillCount ?? item.fills.length} 笔</summary>
          <div className="table-wrap"><table>
            <caption>订单状态</caption>
            <thead><tr><th>时间</th><th>腿 / 方向</th><th>状态</th><th>已成交 / 委托数量</th><th>价格</th></tr></thead>
            <tbody>{item.orders.map(order => <tr key={order.id}><td>{time(order.at)}</td><td>{legName(order.leg)} / {sideName(order.side)}</td><td>{orderLabels[order.state.toLowerCase()] || order.state}</td><td>{format(order.filledQuantity, 8)} / {format(order.quantity, 8)}</td><td>{format(order.price, 6)}</td></tr>)}</tbody>
          </table></div>
          <div className="table-wrap"><table>
            <caption>已确认模拟成交</caption>
            <thead><tr><th>时间</th><th>腿 / 方向</th><th>数量</th><th>价格</th><th>手续费 USDT</th><th>类型</th></tr></thead>
            <tbody>{item.fills.map((fill, index) => <tr key={`${fill.id}:${fill.at}:${index}`}><td>{time(fill.at)}</td><td>{legName(fill.leg)} / {sideName(fill.side)}</td><td>{format(fill.quantity, 8)}</td><td>{format(fill.price, 6)}</td><td>{format(fill.fee, 6)}</td><td>{fill.kind === 'repair' ? '修复成交' : fill.kind === 'entry' ? '开仓成交' : fill.kind === 'exit' ? '退出成交' : '模拟成交'}</td></tr>)}</tbody>
          </table></div>
          {(item.orderCount ?? 0) > item.orders.length && <p className="detail-note">列表显示最近 {item.orders.length} 笔订单与 {item.fills.length} 笔成交，计数为任务累计值。</p>}
        </details>
      </article>
    ))}</div>
  </section>;
}

export default function PositionsPanel({ state, now, stale, online, busy, close, executionAction }: {
  state: State; now: number; stale: boolean; online: boolean; busy: boolean;
  close: (id: string) => void; executionAction: (id: string, action: 'retry' | 'cancel') => void;
}) {
  const executions = state.executions || [];
  return <>
    <ExecutionPanel executions={executions} now={now} disabled={busy || !online} act={executionAction}/>
    <section className="panel">
      <div className="section-heading"><div><h2>模拟持仓</h2><p>{!state.config.enabled ? '全部自动操作已暂停，仍可手动平仓。' : state.config.entryPaused ? '新仓已暂停，已有持仓继续自动退出管理。' : '自动检查止盈、止损和持有时限；可单独暂停新仓。'} BBO 用于参考，逐档深度用于判断可退出性。</p></div></div>
      {state.positions.length ? <div className="positions">{state.positions.map(p => (
        <PositionCard key={p.id} p={p} now={now} online={online} staleReason={valuationStaleReason(p.valuation, now, stale)}
          disabled={busy || !online || executions.some(item => item.positionId === p.id && !terminal(item))} close={() => close(p.id)}/>
      ))}</div> : <div className="empty"><h3>还没有模拟持仓</h3><p>可从机会中开仓；分阶段执行进度会先显示在上方任务中。</p></div>}
    </section>
  </>;
}
