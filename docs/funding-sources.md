# 模拟资金费来源与会计口径

核实日期：2026-09-23。所有读取均为固定交易所域名的公开数据；没有账户、API Key、签名或真实订单。

## 来源与字段

| 来源 | 历史与当前接口 | 本模块采用的原生口径 |
| --- | --- | --- |
| [Binance 官方市场数据文档](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/market-data) | `GET /fapi/v1/fundingRate`；`premiumIndex`、`fundingInfo` | 历史 `fundingTime` 为毫秒、`fundingRate` 为比例；历史 `markPrice` 明确对应当次资金费。调整后的周期取 `fundingIntervalHours`，无调整记录采用默认 8 小时。只接受普通永续 `Regular`，不混入特殊分红费用。 |
| [Bybit 历史](https://bybit-exchange.github.io/docs/v5/market/history-fund-rate)、[合约元数据](https://bybit-exchange.github.io/docs/v5/market/instrument)、[行情](https://bybit-exchange.github.io/docs/v5/market/tickers) | `GET /v5/market/funding/history`、`instruments-info`、`tickers` | 历史 `fundingRateTimestamp` 为毫秒；当前周期 `fundingInterval` 为分钟。历史没有结算标记价，金额仅能估算。 |
| [OKX 官方文档](https://app.okx.com/docs-v5/zh/#public-data-rest-api-get-funding-rate-history) | `GET /api/v5/public/funding-rate-history`、`funding-rate` | 采用历史实际 `realizedRate`，不以预测 `fundingRate` 替代。毫秒 `fundingTime`；当前两次原生时间之差确定周期。历史仅覆盖近三个月，本模块保守采用 89 天；更早区间标记不完整。 |
| [Gate 官方永续文档](https://www.gate.com/docs/developers/apiv4/en/futures/#futures-market-historical-funding-rate) | `GET /api/v4/futures/usdt/funding_rate`、`contracts/{symbol}` | 历史 `t` 为秒、`r` 为比例；当前 `funding_interval` 为秒、`funding_next_apply` 为秒。不把当前 `mark_price` 用于历史结算。 |
| [Kraken 历史接口](https://docs.kraken.com/api-reference/historical-funding-rates/historical-funding-rates)、[线性永续规则](https://support.kraken.com/articles/perpetual-contract-specifications-for-clients-in-the-eea) | `GET /derivatives/api/v3/historical-funding-rates?symbol=...` | `timestamp` 为 ISO 时间，绝对 `fundingRate` 为每单位基础币每小时金额；`relativeFundingRate` 仅用于当前费率展示。小时费率从该时间开始连续累计，在整点或该腿数量变化时模拟结算。仅支持当前普通线性 PF 合约的小时规则，缺小时数据保持未知。 |
| [Hyperliquid 历史接口](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals)、[资金费规则](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/funding) | 仅 `POST /info` 的 `fundingHistory`、`metaAndAssetCtxs` | 历史 `time` 保留实际毫秒时间，费率为每小时比例。计算用 oracle 价格；历史不返回该价格，不能借用 mark price 确认资金费金额。 |
| [Lighter 历史接口](https://apidocs.lighter.xyz/reference/fundings)、[官方 SDK 数据结构](https://github.com/elliottech/lighter-python/blob/main/docs/Funding.md)、[资金费规则](https://docs.lighter.xyz/trading/funding) | `GET /api/v1/fundings`，先用 `orderBookDetails` 复核 market ID | 使用 `1h`，`timestamp` 秒转毫秒；非负百分数 `rate` 除以 100，`direction=long` 表示多付空收，`short` 反向。金额依赖当期 index，保持历史结算价未知。`/funding-rates` 是跨所比较，不用它伪造 Lighter 当前结算信息，故当前值可以为空。 |

Lighter 的百分数/方向适配除官方字段和资金费公式外，还对公开 `/fundings` 原始响应作了量纲核对；这是适配器的归一化判断，官方 SDK 的字段表本身没有说明数值单位。`value` 未被当作已确认基础币费用使用。收到负的 magnitude、未知方向或不兼容 schema 会拒绝该批次。

当前费率仅用于展示，并不是未来收益承诺。当前周期不被套用到全部旧历史；历史时间之间的间隔单独保留。缺失周期为 `null`，不统一假设 8 小时。

## 读取限制及覆盖

`createFundingClient({ fetcher, clock, timeoutMs }).read(quote, from, to)` 使用毫秒闭区间 `[from,to]`。返回字段 `coveredFrom/coveredTo/complete` 表示历史读取覆盖，不表示金额已知。异常、到达分页上限、缺失历史或未发布当期结算都不能被计作零。

每次 HTTP 请求最多 8 秒，解码后的 JSON 最多 8 MiB，禁止重定向。历史每次最多 3 页，保留已读范围；请求区间最多 366 天。相同查询合并在途请求并缓存 30 秒；每个交易所一次只跑一个查询，成功后至少冷却 1 秒，读取失败后 30 秒。缓存总计最多 128 项。只有 Hyperliquid 允许固定的两种公共 POST，其余均为 GET。

空数组只有在新鲜的原生当前周期能够证明区间内没有结算时才视为完整零结算。当前端点失败不抹掉已取得的历史；当前信息过期时不用于上述证明。

## 会计与幂等

`fundingLedger(position, { long, short }, now)` 是无网络、无存储副作用的纯函数。主服务负责保存输入历史、流水和请求覆盖。普通离散结算按 `(openedAt,closedAt]`；同毫秒成交约定在资金费之后生效，因而用严格早于结算时刻的最新腿数量。

`quantityHistory` 每行保存 `at/longQuantity/shortQuantity` 十进制字符串，可附当时 `fx`。Kraken 按实际持有的每个时间片计算小时比例：历史记录还返回 `accruals`，包含 `accrualStart/accrualEnd` 与 `unit=per_base`。未到整点且未改变该腿数量的累计项为 `accrued_unsettled`，只进入估算；单纯新增汇率样本不触发资金费结算。

原币金额和折算金额使用统一十进制运算。USDT 换算恒为 1；其他币种仅可用入场或数量历史中保存、来源时间不晚于结算且当时未过期的 FX 确认。旧入场 FX 只能支持明确标记的估算，不能代替历史汇率。正现金流用 bid，负现金流用 ask。缺少历史定价时用入场成交价估算；缺少一腿、历史范围或估算依据时保持未知。

- `confirmed`：区间完整且所有应结算项金额可确认时的合计，否则 `null`。
- `known`：已确认子集的合计，不能被称为完整资金费。
- `estimated`：完整历史范围的已确认加估算合计；历史覆盖不足或存在无法估算项时 `null`。
- `entries[].quality`：区分确认、定价估算、FX 估算、两者估算、尚未结算和未知。
- `entries[].key`：普通结算为 `positionId:leg:at`；连续累计分段为 `positionId:leg:start:end`。按此键更新而非叠加，可防重复读取或重启重复计费。

同一键出现费率冲突时保留不完整状态。迟到数据重算整个账本；主服务应在同一事务更新流水、持仓汇总及历史版本。这里的“确认”仅指有公开数据依据的模拟金额，与真实账户账单无关。

`accountingVersion < 3` 返回 `legacy`，不重写原有历史收益，不将未收集的数据推算为零。价格损益、手续费、资金费与 FX 影响应由上层分别展示。

## 验证

`node --test tests/funding-client.test.mjs tests/funding.test.mjs` 使用注入的隔离响应，覆盖七所字段、费率符号与时间，未知/零区别、重复/迟到数据、数量变化、结算边界、历史 FX、Kraken 连续累计、分页、身份变化、响应大小和冷却。测试不连接交易所或账户，不使用 WSL。
