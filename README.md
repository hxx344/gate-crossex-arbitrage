# Gate CrossEx · 永续价差套利模拟

接收 [Market Monitor](https://github.com/hxx344/market-spread-monitor) 发现的价差，核对 Gate CrossEx 合约目录，在真实公共盘口深度上模拟开仓、持仓估值和平仓。作为独立模块接入 [Project Aggregation](https://github.com/hxx344/project-aggregation) 工作台，也可以单独访问。

**当前版本只做本地模拟，不发送真实订单，不连接交易账户，不需要交易所 API Key。** Gate CrossEx 的接入是读取官方合约规则并核对执行范围；成交记录由本模块模拟，不是 Gate 沙盒订单。资金费、单腿成交风险、强平及网络延迟尚未建模。

## 联动方式

```text
Market Monitor 公共行情与价差发现
  → /api/monitors/perpetual/opportunities-v2
  → CrossEx 合约可用性、数量与额度检查
  → 七所公共深度与 USDC / USD 汇率复核
  → 模拟双腿开仓 → 持仓估值 → 模拟平仓 → SQLite 记录
  → 工作台独立入口与摘要（不计入真实资产）
```

- 支持 Binance、Bybit、OKX、Gate、Kraken、Hyperliquid、Lighter 七所，明确排除 Deribit。仅同币种、单位为 1 的普通加密永续；支持集合由 Monitor 当前身份资料与 CrossEx 合约目录共同决定。未知标的、倍数、盘前、非加密及已知下架合约不参与开仓。具体契约见 [联动接口](https://github.com/hxx344/market-spread-monitor/blob/main/docs/CROSSEX_SIGNALS.md)。
- Binance / Bybit / OKX 支持 USDT、USDC；Gate 为 USDT；Kraken 为 USD；Lighter 为 USDC。Hyperliquid 普通永续用 USDT 报价、USDC 结算，HYPE / PURR 为 USDC 报价与结算。报价、结算和保证金币种分别保留，不互相替代。
- USDC / USDT 取 Gate 现货买卖价；USD / USDT 取 Kraken 的 USDT / USD 盘口倒数并反转买卖方向。缺失、倒退、超过 3 分钟的汇率不能用于新模拟，绝不默认兑价为 1。等基础币数量不能对冲结算币汇率风险，本版本没有模拟换汇深度或外汇对冲。
- Gate / OKX 公开深度的合约张数换算为基础币数量。CrossEx 的订单数量规则已按基础币计量，不重复乘已弃用的 contract_size。官方目录明确为 null 的最小名义额或最大市价数量，会显示“未提供”，不会声称通过该项校验；本地额度、最小数量、步长和深度限制仍执行。
- 每 5 秒后台读取信号；Gate 合约目录每 5 分钟更新，短暂失败可使用不超过 15 分钟的缓存并显示状态。打开浏览器不是后台运行条件。
- 自动模拟默认关闭。可手动开平仓，或设置预算、手续费、滑点上限、净价差门槛、止盈止损、最长持有时间后启动自动模拟。
- 每次开平仓都读取两腿公共盘口，双腿在滑点范围内都能全量模拟成交才记账。该同步模型不等于交易所提供原子双腿订单。
- 每腿按原始盘口时间检查，超过 10 秒、未来超过 1 秒或两腿相差超过 5 秒就拒绝。断线保留旧估值并明确过期，不把旧报价变成新收益。
- 每币种最多一个活动持仓；请求、信号、平仓后冷却持久去重，重启继续保存的持仓与自动模拟设置。

## 一条命令安装或升级

适用于使用 systemd 的 Debian / Ubuntu。已有配置和数据库保持不变：

```bash
sudo bash -c 'set -e; command -v curl >/dev/null || { apt-get update -qq && apt-get install -y curl ca-certificates; }; f=$(mktemp); trap '\''rm -f "$f"'\'' EXIT; curl -fsSL https://raw.githubusercontent.com/hxx344/gate-crossex-arbitrage/main/install.sh -o "$f"; bash "$f"'
```

已在同机部署 Monitor 和工作台时，用以下一条命令依次更新联动的三个项目：

```bash
sudo bash -c 'set -e; f=$(mktemp); trap '\''rm -f "$f"'\'' EXIT; for path in market-spread-monitor/main/deploy/install.sh gate-crossex-arbitrage/main/install.sh project-aggregation/main/install.sh; do printf "\n更新 %s\n" "$path"; curl -fsSL "https://raw.githubusercontent.com/hxx344/$path" -o "$f"; bash "$f"; done'
```

安装器复用 Node.js 24.15.0+ 的 24.x 运行时。版本、环境和配置未变化时跳过下载、安装、检查、构建及重启；依赖和页面构建按内容缓存。失败恢复前一程序与上次健康配置，数据不回滚。详见 [部署与恢复](docs/deployment.md)。

## 在工作台使用

1. 更新后左侧会出现 **Gate CrossEx**。默认页面/接口为 `http://127.0.0.1:3200`，适配器 `standard`，访问方式 `proxy`。
2. 在服务器查看本模块首次启动日志：`sudo journalctl -u gate-crossex-arbitrage --no-pager -n 30`。用户名为 `admin`，密码独立于工作台与 Monitor。在工作台“项目管理”保存它，以后可自动进入。
3. 进入 CrossEx 的“连接与设置”，填写价差服务地址 `http://127.0.0.1:3000` 和 **Market Monitor 的网页登录用户名、密码**。只有同机回环地址被接受；更换目标地址或用户名会清除旧密码。
4. 检查来源状态，按模拟用途调整参数，然后选择机会模拟开仓或启动自动模拟。

继续使用已有的工作台 SSH 转发 `3100`，不需要新增转发。模拟余额和盈亏单独展示，不进入 Asset Ledger 总额。若单独使用此模块，可转发 `3200`，浏览器会要求输入模块 Basic 登录信息。

自动模拟暂停会同时停止自动开仓和平仓；手动平仓仍可用。已有持仓保存开仓时的费用、滑点、止盈止损和时限规则，后续修改参数只影响新仓。行情或深度不可用时无法模拟成交，持仓继续保留并显示异常。

## 费用与收益口径

默认参数仅用于模拟：单腿 100 USDT、同时最多 3 组、双腿总名义额上限 1000 USDT、每次手续费 6 bp、每次滑点上限 5 bp、预算净价差至少 20 bp。1 bp = 0.01%，这些不是个人 CrossEx 账户费率。额度是名义额预算，不是账户权益或杠杆保证金模型。

毛价差 = `(空腿买一 / 多腿卖一 − 1) × 10000 bp`；机会的预算净价差减去四次手续费和四次滑点预算。复核成交深度后，入场均价已经包含逐档滑点，仅另留两次退出滑点预算；不会把已体现在均价里的滑点重复扣费。

每腿先按原始合约价格计算损益：多腿为 `数量 × (平仓价 − 开仓价)`，空腿为 `数量 × (开仓价 − 平仓价)`。再按各腿结算币换算为 USDT，盈利用买价、亏损用卖价；开仓费用按入场汇率保存，平仓费用按退出汇率计算。不会用两次汇率分别换算完整开平仓名义额后相减，避免凭空计入并未持有的外汇资产损益。全 USDT 旧持仓沿用原口径和数据。资金费是**未建模**，不是收入为零的已确认事实；页面与摘要均注明未含资金费。持仓浮动值使用平仓方向盘口与预计退出费用，最终平仓重新检查深度。

收益曲线只使用实际保存的模拟平仓记录，按北京时间展示。最近 200 笔在页面可查，累计指标包含全部记录。

## 开发与验证

Windows 原生 Node 24.15.0+：

```powershell
npm ci
npm run check
npm test
npm run build
npm start
```

开发页面用 `npm run dev`（5174），后台 `npm run dev:server`（3200）。分离开发时后台设置 `PUBLIC_ORIGIN=http://127.0.0.1:5174`；默认 SSH / HTTP 工作台代理部署留空。直接通过 HTTPS 反向代理访问时，设置 `PUBLIC_ORIGIN=https://实际域名`；若同时从工作台代理进入，还需把工作台该项目的“登录来源地址”设置为同一地址。默认开发数据在被忽略的 `.data/`。Linux 验证交由 Ubuntu CI，不使用 WSL。

测试使用隔离的确定性数据，不代表你的服务器已部署、账户已开通或策略已盈利。线上首次安装仍需要填写已有 Monitor 登录信息。

## 官方接口依据

2026-09-22 核对：[Gate CrossEx](https://www.gate.com/docs/developers/crossex/zh_CN/) 的 `GET /api/v4/crossex/rule/symbols` 无需认证；模块同时使用 [Binance USDⓈ-M 深度](https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Order-Book) 和 [Bybit 线性深度](https://bybit-exchange.github.io/docs/v5/market/orderbook)。其余规则及公开接口见 [OKX](https://www.okx.com/docs-v5/en/)、[Kraken Futures](https://docs.kraken.com/api/docs/futures-api/websocket/book/)、[Hyperliquid 合约说明](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/contract-specifications)、[Lighter](https://apidocs.lighter.xyz/docs/websocket-reference)。行情请求包含只读 GET、Hyperliquid info POST，以及 Kraken / Lighter 单次公开 WebSocket 快照；服务中没有私有交易所 API 写请求。
