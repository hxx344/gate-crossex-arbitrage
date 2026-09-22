import { useEffect, useState } from 'react';
import { format, scenarioNames, time, venues } from './display';
import type { Config, ExecutionScenario, FeeRule } from './types';

type NumericKey = { [K in keyof Config]-?: Config[K] extends number ? K : never }[keyof Config];
type NumericField = [NumericKey, string, string];
const strategyFields: NumericField[] = [
  ['notionalPerLeg', '单腿名义额', 'USDT'], ['maxTotalNotional', '双腿总名义额上限', 'USDT'],
  ['maxOpen', '最多同时持仓', '组'], ['slippageBps', '每次成交滑点上限', 'bp'],
  ['minNetBps', '最低预算净价差', 'bp'], ['takeProfitBps', '止盈 / 单腿开仓额', 'bp'],
  ['stopLossBps', '止损 / 单腿开仓额', 'bp'], ['maxHoldMinutes', '最长持有', '分钟'],
  ['cooldownSeconds', '同币种平仓后冷却', '秒'],
];
const executionFields: NumericField[] = [
  ['clipNotional', '每批单腿模拟名义额', 'USDT'], ['executionDelayMs', '阶段间模拟延迟', '毫秒'],
  ['partialFillPct', '部分成交场景比例', '%'], ['repairAttempts', '自动修复尝试上限', '次'],
  ['executionSeed', '场景随机种子', '整数'],
];
const samplingFields: NumericField[] = [
  ['depthRefreshSeconds', '退出深度复核周期', '秒'], ['historySampleSeconds', '净值与价差采样周期', '秒'],
];
const integerKeys = new Set<NumericKey>(['maxOpen', 'executionSeed', 'repairAttempts']);
function editableConfig(config: Config): Config {
  const { hasMonitorPassword: _, ...value } = config;
  return { ...value, entryPaused: value.entryPaused ?? false, feeSchedule: value.feeSchedule ?? [],
    executionMode: value.executionMode ?? 'atomic', executionScenario: value.executionScenario ?? 'normal', executionSeed: value.executionSeed ?? 1,
    executionDelayMs: value.executionDelayMs ?? 250, clipNotional: value.clipNotional ?? 25, partialFillPct: value.partialFillPct ?? 50,
    repairAttempts: value.repairAttempts ?? 3, fundingEnabled: value.fundingEnabled ?? true,
    depthRefreshSeconds: value.depthRefreshSeconds ?? 15, historySampleSeconds: value.historySampleSeconds ?? 15 };
}

export default function SettingsForm({ config, busy, save }: {
  config: Config; busy: boolean; save: (input: object) => Promise<boolean | undefined>;
}) {
  const [draft, setDraft] = useState(() => editableConfig(config));
  const [password, setPassword] = useState(''), [clear, setClear] = useState(false), [saved, setSaved] = useState(false);
  useEffect(() => {
    setDraft(value => ({ ...value, enabled: config.enabled, entryPaused: !!config.entryPaused }));
  }, [config.enabled, config.entryPaused]);
  function updateFee(index: number, patch: Partial<FeeRule>) {
    setDraft(value => ({ ...value, feeSchedule: value.feeSchedule.map((rule, i) => i === index ? { ...rule, ...patch, updatedAt: Date.now() } : rule) }));
  }
  function addFee() {
    setDraft(value => ({ ...value, feeSchedule: [...value.feeSchedule, { exchange: 'binance', symbol: '', makerBps: value.feeBps, takerBps: value.feeBps, source: '手动配置', updatedAt: Date.now() }] }));
  }
  function numericFields(fields: NumericField[]) {
    return <div className="form-grid">{fields.map(([key, label, unit]) => (
      <label key={key}>{label}
        <div className="input-unit">
          <input required type="number" step={integerKeys.has(key) ? '1' : 'any'} value={draft[key]}
            onChange={e => setDraft(value => ({ ...value, [key]: Number(e.target.value) }))}/>
          <span>{unit}</span>
        </div>
      </label>
    ))}</div>;
  }
  return (
    <form onChange={() => setSaved(false)} onSubmit={async e => {
      e.preventDefault(); setSaved(false);
      if (await save({ config: draft, ...(password ? { monitorPassword: password } : {}), clearMonitorPassword: clear })) {
        setSaved(true); setPassword(''); setClear(false);
      }
    }}>
      <section className="panel settings-panel">
        <h2>运行与新仓控制</h2>
        <p className="muted">暂停新仓后，已有持仓的自动退出仍按总开关运行；暂停全部自动后可手动处理持仓与执行任务。</p>
        <label className="check"><input type="checkbox" checked={draft.enabled} onChange={e => setDraft(value => ({ ...value, enabled: e.target.checked }))}/>启用自动模拟开仓与退出</label>
        <label className="check"><input type="checkbox" checked={draft.entryPaused} onChange={e => setDraft(value => ({ ...value, entryPaused: e.target.checked }))}/>只暂停新仓，保留已有持仓的退出管理</label>
      </section>
      <section className="panel settings-panel">
        <h2>价差服务连接</h2>
        <p className="muted">填写 Market Monitor 的网页登录信息，密码加密保存在此模块服务器。</p>
        <div className="form-grid">
          <label>同机服务地址<input required value={draft.monitorUrl} onChange={e => setDraft(value => ({ ...value, monitorUrl: e.target.value }))}/></label>
          <label>登录用户名<input value={draft.monitorUsername} autoComplete="off" onChange={e => setDraft(value => ({ ...value, monitorUsername: e.target.value }))}/></label>
          <label>登录密码<input type="password" value={password} autoComplete="new-password" placeholder={config.hasMonitorPassword ? '已保存，留空保留' : '尚未保存'} onChange={e => setPassword(e.target.value)}/></label>
        </div>
        <label className="check"><input type="checkbox" checked={clear} onChange={e => setClear(e.target.checked)}/>清除已保存的价差服务密码</label>
        <p className="footnote">更换地址或用户名会清除旧密码。默认地址为 http://127.0.0.1:3000。</p>
      </section>
      <section className="panel settings-panel">
        <h2>模拟策略参数</h2>
        <p className="muted">参数变更用于后续开仓；已有持仓保留开仓时的费率与退出规则。1 bp = 0.01%。</p>
        {numericFields(strategyFields)}
      </section>
      <section className="panel settings-panel">
        <h2>分交易所与合约的手续费</h2>
        <p className="muted">多腿开仓、多腿退出、空腿开仓、空腿退出分别记账。当前按公共深度模拟吃单，使用 Taker 费率；Maker 配置不代表获得挂单成交。费率是手动假设，不是账户费率查询。</p>
        {numericFields([['feeBps', '未命中配置时的每次手续费', 'bp']])}
        <div className="fee-rules">
          {draft.feeSchedule.map((rule, index) => (
            <fieldset key={index} className="fee-rule">
              <legend>费率规则 {index + 1}</legend>
              <div className="form-grid">
                <label>交易所<select value={rule.exchange} onChange={e => updateFee(index, { exchange: e.target.value })}>{Object.entries(venues).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
                <label>合约（留空覆盖该所）<input value={rule.symbol} placeholder="如 BTCUSDT" onChange={e => updateFee(index, { symbol: e.target.value })}/></label>
                <label>Maker 手续费<div className="input-unit"><input required type="number" step="any" value={rule.makerBps} onChange={e => updateFee(index, { makerBps: Number(e.target.value) })}/><span>bp</span></div></label>
                <label>Taker 手续费<div className="input-unit"><input required type="number" step="any" value={rule.takerBps} onChange={e => updateFee(index, { takerBps: Number(e.target.value) })}/><span>bp</span></div></label>
                <label>费率来源说明<input required value={rule.source} placeholder="手动填写费率依据" onChange={e => updateFee(index, { source: e.target.value })}/></label>
                <div className="fee-rule-meta"><small>更新时间 {time(rule.updatedAt)}</small><button type="button" onClick={() => setDraft(value => ({ ...value, feeSchedule: value.feeSchedule.filter((_, i) => i !== index) }))}>删除规则 {index + 1}</button></div>
              </div>
            </fieldset>
          ))}
        </div>
        {!draft.feeSchedule.length && <p className="muted">尚未配置专属费率，四次成交均使用默认 {format(draft.feeBps)} bp。</p>}
        <button type="button" onClick={addFee}>添加费率规则</button>
      </section>
      <section className="panel settings-panel">
        <h2>执行模式与故障场景</h2>
        <p className="muted">分阶段模式记录模拟订单与成交、双腿未对冲量、重试和撤销过程；延迟及故障由所选场景生成。</p>
        <div className="form-grid">
          <label>执行模式<select value={draft.executionMode} onChange={e => setDraft(value => ({ ...value, executionMode: e.target.value as Config['executionMode'] }))}><option value="atomic">原子模拟 · 双腿全量成交后记账</option><option value="staged">分阶段模拟 · 分批成交与修复</option></select></label>
          <label>模拟场景<select disabled={draft.executionMode !== 'staged'} value={draft.executionScenario} onChange={e => setDraft(value => ({ ...value, executionScenario: e.target.value as ExecutionScenario }))}>{Object.entries(scenarioNames).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
        </div>
        <fieldset className="plain-fieldset" disabled={draft.executionMode !== 'staged'}>{numericFields(executionFields)}</fieldset>
        <p className="footnote">场景、种子与阶段延迟用于复现模拟过程，不代表实际交易所订单响应。原子模式不会产生真实的双腿原子订单。</p>
      </section>
      <section className="panel settings-panel">
        <h2>资金费、退出深度与历史采样</h2>
        <label className="check"><input type="checkbox" checked={draft.fundingEnabled} onChange={e => setDraft(value => ({ ...value, fundingEnabled: e.target.checked }))}/>读取公开资金费并计入可确认的模拟结算</label>
        <p className="muted">完整确认、部分已知和持有期估算分别展示。缺少费率或结算历史时保留未知，不把资金费当成零。退出深度按设定周期复核，过期快照不会显示为可立即退出。</p>
        {numericFields(samplingFields)}
        <p className="footnote">历史采样保存累计模拟盈亏与持仓价差。图表缺口表示该时点无法确认完整估值，回撤单位为 USDT。</p>
        <div className="save-row"><button className="primary" disabled={busy} type="submit">{busy ? '正在保存…' : '保存全部设置'}</button>{saved && <span role="status" className="positive">已保存</span>}</div>
      </section>
    </form>
  );
}
