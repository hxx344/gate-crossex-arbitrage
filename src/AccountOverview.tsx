import type { LiveView } from './live-types';
import { exact } from './live-display';
import { decimalField, percentage } from './position-view';

export default function AccountOverview({ live }: { live: LiveView }) {
  const account = live.account;
  const metrics = [
    { label: '可用保证金', value: exact(decimalField(account, 'available_margin')), note: 'USDT · 账户保证金口径', accent: true },
    { label: '保证金权益', value: exact(decimalField(account, 'margin_balance')), note: 'USDT · 账户保证金口径' },
    { label: '初始保证金', value: exact(decimalField(account, 'initial_margin')), note: 'USDT · 账户保证金口径' },
    { label: '维持保证金', value: exact(decimalField(account, 'maintenance_margin')), note: 'USDT · 账户保证金口径' },
    { label: '初始保证金率', value: percentage(decimalField(account, 'initial_margin_rate')), note: '交易所返回比例' },
    { label: '维持保证金率', value: percentage(decimalField(account, 'maintenance_margin_rate')), note: '交易所返回比例' },
  ];
  return <section className="account-overview" aria-label="账户总览">{metrics.map(metric => <div key={metric.label} className={metric.accent ? 'account-metric accent' : 'account-metric'}><span>{metric.label}</span><strong title={metric.value}>{metric.value}</strong><small>{metric.note}</small></div>)}</section>;
}
