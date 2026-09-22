import { Fragment, lazy, Suspense } from 'react';
import { direction, format, signedClass, time } from './display';
import PnlBreakdown from './PnlBreakdown';
import type { State } from './types';

const ProfitChart = lazy(() => import('./ProfitChart'));
export default function HistoryPanel({ state, online }: { state: State; online: boolean }) {
  return <>
    {!online && <div className="notice warning" role="status">连接中断，保留上次读取的历史与采样；以下时间不会随页面刷新延长。</div>}
    {state.analytics?.samples.length ? <Suspense fallback={<div className="panel empty">正在加载净值与回撤曲线…</div>}><ProfitChart analytics={state.analytics}/></Suspense> : <section className="panel empty"><h3>等待持续采样</h3><p>后台会按采样周期保存模拟净值与持仓价差；不需要先平仓。</p></section>}
    <section className="panel history-panel">
      <div className="section-heading"><div><h2>模拟平仓记录</h2><p>价格盈亏、手续费、资金费分别展示；资金费记录不完整时，不展示完整净盈亏。</p></div></div>
      {state.history.length ? <div className="table-wrap"><table>
        <thead><tr><th>币种 / 方向</th><th>开仓 / 平仓时间</th><th>多腿 / 空腿开仓量</th><th>总手续费 USDT</th><th>价差净盈亏 USDT</th><th>确认资金费 USDT</th><th>含资金费净盈亏 USDT</th><th>平仓原因</th></tr></thead>
        <tbody>{state.history.map(p => <Fragment key={p.id}><tr>
          <td><strong>{p.base}</strong><small>{direction(p)}</small></td>
          <td>{time(p.openedAt)}<small>{time(p.closedAt)}</small></td>
          <td>{format(p.longFill.quantity ?? p.quantity, 8)}<small>{format(p.shortFill.quantity ?? p.quantity, 8)}</small></td>
          <td>{format(p.entryFees + (p.result?.exitFees ?? 0), 4)}</td>
          <td className={signedClass(p.result?.net)}>{format(p.result?.net, 4)}</td>
          <td className={signedClass(p.funding?.confirmed)}>{format(p.funding?.confirmed, 4)}<small>{p.funding?.status === 'complete' ? '结算记录完整' : p.funding?.status === 'partial' ? `仅已知 ${format(p.funding.known, 4)}，仍有缺失` : '未完整确认'}</small></td>
          <td className={signedClass(p.result?.netWithFunding)}>{format(p.result?.netWithFunding, 4)}</td>
          <td>{p.reason}</td>
        </tr><tr className="history-detail-row"><td colSpan={8}><PnlBreakdown value={p.result} entryFees={p.entryFees} funding={p.funding} title={p.base + ' 收益明细'}/></td></tr></Fragment>)}</tbody>
      </table></div> : <div className="empty">平仓后显示模拟记录</div>}
      <div className="footnote">显示最近 200 笔；累计指标包含所有已保存的平仓记录。价差净盈亏已扣实际模拟手续费；未确认的估算资金费不计入已确认收益。</div>
    </section>
    <section className="panel event-panel"><h2>运行记录</h2>{state.events.map((event, index) => <div className="event" key={`${event.at}:${index}`}><time>{time(event.at)}</time><span>{event.message}</span></div>)}{!state.events.length && <p className="muted">暂无操作记录</p>}</section>
  </>;
}
