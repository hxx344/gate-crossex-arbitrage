# Gate CrossEx 手动实盘

通过 Gate CrossEx 接入真实账户，提供深色交易终端、单腿订单票、跨所 A/B 双腿开仓、按基础币归组的账户组合、逐腿或整组部分平仓，以及挂单撤销。后台只刷新行情、账户和原订单状态；不自动开仓、平仓、补单或恢复未发送的订单腿。

前端布局与后端账户、订单、费用和行情契约参考 [your-quantguy/gate-crossex](https://github.com/your-quantguy/gate-crossex)，参考版本 `423356d`。保留本项目的一键部署与工作台接入方式。项目采用 AGPL-3.0-only，见 [LICENSE](LICENSE) 和[来源说明](THIRD_PARTY_NOTICES.md)。

独立手动交易覆盖 Binance、OKX、Bybit、Gate、Kraken Futures、Hyperliquid、Lighter 和 Deribit 的普通加密永续，并允许原生分类和单位已确认的 OKX / Gate 非加密线性合约单腿交易；实际可交易合约以当前目录、原生合约身份、账户模式及权限为准。双腿仅支持身份可比的加密合约。Market Monitor 提供的价差机会可以预填双腿。平台只保存 Gate CrossEx API Key / Secret。

## 一条命令安装或升级

适用于使用 systemd 的 Debian / Ubuntu，保留已有配置与数据库：

```bash
sudo bash -c 'set -e; command -v curl >/dev/null || { apt-get update -qq && apt-get install -y curl ca-certificates; }; f=$(mktemp); trap '\''rm -f "$f"'\'' EXIT; curl -fsSL https://raw.githubusercontent.com/hxx344/gate-crossex-arbitrage/main/install.sh -o "$f"; bash "$f"'
```

同机安装 Monitor 和工作台时，依次更新三个项目：

```bash
sudo bash -c 'set -e; f=$(mktemp); trap '\''rm -f "$f"'\'' EXIT; for path in market-spread-monitor/main/deploy/install.sh gate-crossex-arbitrage/main/install.sh project-aggregation/main/install.sh; do printf "\n更新 %s\n" "$path"; curl -fsSL "https://raw.githubusercontent.com/hxx344/$path" -o "$f"; bash "$f"; done'
```

安装器使用 Node.js 24.15.0+ 的 24.x 运行时，默认下载经过 CI 验证并明确发布的正式部署包，固定提交地址并校验 SHA-256。服务器不运行 npm 安装、类型检查、测试或前端编译；包内包含后端、页面及锁定的 ws/decimal.js 运行依赖。没有变化且健康时跳过应用下载和重启，已有配置与数据库保留。尚未发布新正式版时使用现有正式版；首次没有可用正式包则停止。详见[部署与恢复](docs/deployment.md)。

`main` CI 全部通过后，只发布 `deploy-<完整提交号>` 候选 Release（`prerelease`），不改变当前正式版。发布者在 GitHub Actions 选择 **[Publish stable release](.github/workflows/promote-release.yml)**，分支选 `main`，在 `commit` 中填写已通过本仓库 CI 的完整 40 位提交 SHA 后运行；核验清单和部署包后，候选才晋级为最新正式版。默认安装及工作台前端更新只使用正式版，未晋级的候选不会自动安装。

开发排查可显式使用 `sudo env PROJECT_DEPLOY_MODE=source bash install.sh` 恢复原源码部署。`PROJECT_DEPLOY_TESTS=1` 或总部署 `--with-tests` 只在 source 模式补测；CI 模式不在服务器重复测试。

## 连接与操作

1. 工作台项目使用 `http://127.0.0.1:3200`、`standard` 适配器和 `proxy` 访问。用户名为 `admin`，首次密码在 `sudo journalctl -u gate-crossex-arbitrage --no-pager -n 30` 中查看并保存到工作台。
2. 在设置中连接 Gate CrossEx API Key / Secret。服务只读验证账户、持仓和挂单；接口未返回 UID 时保持缺失，并以本地连接版本隔离记录。不能预先证明写权限，最终由 Gate 接单时校验。凭据使用 AES-256-GCM 加密，页面只显示尾号。
3. 在交易终端选择合约、方向、类型和数量；或在跨所对冲页选择多空两所与等基础币数量。预览数量、限价、账户、保证金和费用后，再确认实盘提交。
4. 在账户持仓展开基础币分组，选择单腿或多腿，使用 25% / 50% / 75% / 100% 或精确数量平仓。每次都重新预览所选减仓订单。
5. 在订单记录中核对部分成交、未知状态和手动撤单。可选连接 Monitor 的回环地址（通常 `http://127.0.0.1:3000`）及网页登录凭据，用于发现机会；独立手动订单和平仓不依赖 Monitor 在线。

单腿预算限制的是折算为 USDT 的名义额，不是杠杆后的保证金。校验金额按数量 × 委托价与当前盘口估值中的较高值 × 结算币汇率计算，可能高于订单票中的原币参考金额；预览会显示校验金额与上限，超限提示会列出金额、上限和差额。确认时重新估值，再检查单腿预算、总名义额、保证金与风险档位：额度内的价格或汇率变化不再单独导致预览失效，原委托数量、限价和盘口深度约束仍保留。

连接设置独立加载。完整账户或行情状态读取失败时，仍可填写凭据、重试初始化并修正连接。候选机会仅在跨所对冲页读取，合约目录按需加载并短期复用，避免进入设置或查看持仓时反复计算全部行情。

继续复用工作台 SSH 转发 `3100`；单独访问时转发 `3200`。工作台和 Monitor 的跳转只定位机会，不触发交易。CrossEx 账户资产不再次计入 Asset Ledger 总资产。

## 订单行为

单腿支持 LIMIT（GTC / IOC / FOK / POC）及 MARKET（IOC / FOK）。市价单的预览金额只用于预算，真实成交价以交易所回报为准。双腿使用等基础币数量的 LIMIT + IOC；手动输入数量须同时满足双方步长，Monitor 机会按共同步长取整。确认前重新核对账户、持仓、挂单、设置、目录、杠杆、风险档位和独立深度；只有来自 Monitor 的机会继续复核其筛选资格。预览最长有效 30 秒。

每腿预算、总名义额、持仓数量及冷却期限制新开仓。现有活动或未知订单未处理完时禁止新增开仓，避免挂单与新仓重复占用额度。保证金按当前只读杠杆估算，并留出 10%；支持跨所共享保证金和交易所隔离模式，不替用户修改杠杆。

两腿依次提交。接单回执不等于成交；服务按原订单标识查询。只有第一腿在本次确认等待内全部成交，才发送第二腿。第一腿部分成交、未知、拒绝或预览失效时，第二腿保持未发送，已成交敞口留给用户手动管理。后台不会继续发第二腿，也不会自动对冲或补单。

平仓始终使用 `reduce_only="true"`，数量不能超过实际持仓。支持外部已有持仓，不依赖原开仓记录、Monitor 在线状态或新仓暂停开关。SINGLE 模式的 NONE 净仓按数量符号推导多空，并显示方向来源；发单使用 NONE 和仅减仓约束。组合平仓最多选择同一基础币的 16 条持仓，分别只提交一次，其中一腿未成交不会自动补单。合约身份、盘口或精度无法核实时拒绝预览。

提交先持久化请求和订单意图，重复请求返回同一结果。中断和未知回报只查询原订单，不重发；撤单须查询到终态才完成。重启后恢复查询，未发送的腿不继续执行。同一数据库仅允许一个实例执行写操作。

## 真实持仓观察

持仓按基础币分组，显示多空数量、净敞口和未对冲状态，展开后逐腿展示交易所、合约、入场价、标记价、未实现盈亏、保证金、强平价及可用的杠杆、已实现盈亏、手续费、资金费和 ADL 信息。方向来源可见，无法判断时不计入净敞口。账户资产按原币显示；缺失字段和过期快照明确标注，不填零。

盘口、持仓和账户数字统一使用精简显示，悬停可查看完整值；极小非零金额保留有效位，极大或极小数使用科学计数法。输入框、下单确认中的委托数量与限价保留完整精度，显示格式不参与数量计算或订单提交。

账户和原订单通常每 5 秒只读刷新，快照超过 15 秒停止新交易；行情来源每 2 秒刷新。手动操作前另行获取账户快照，浏览器是否打开不影响后台同步。订单列表包含本系统轨迹和账户外部挂单。

已打开页面在后台以至少 30 秒的间隔继续只读刷新账户与当前子页行情；设置页仍只读取连接配置，目录继续复用缓存。切回前台、窗口重新获得焦点或恢复页面时立即补查，旧请求不能覆盖新结果；离线暂停，联网后恢复。工作台通过可信 `activity` 消息的 `backgroundUpdates: true` 启用后台读取，`active` 仍表示可见性；旧工作台保留原有暂停行为，独立打开默认允许后台刷新。浏览器冻结、丢弃页面或电脑休眠期间不保证计时器运行，恢复后重新读取；服务器同步不受这些页面状态影响。

账户成交和流水分别展示真实回报。按连接版本和交易／流水 ID 去重保存近期记录；它们是有界的近期明细，不声称覆盖账户全部历史。费用、成交和流水读取失败分别提示，不冻结仍然完整的持仓快照。设置费率用于 Monitor 机会预算；手动预览的费用估算优先使用账户真实费率。缺少完整依据时不构造累计收益。

## 行情口径

交易终端使用 CrossEx 公共 WebSocket 的完整盘口快照、成交价、标记价和资金费率，原生公开盘口作为补充。Gate / OKX 数量按原生确认的合约单位换算为基础币；单位尚未确认时保留原始张数，明确标注“张”，行情仍可查看但不能交易。各类行情分别检查来源时间，原生历史或合约查询失败不会遮住仍有效的 CrossEx 报价。K 线来自交易所真实历史接口，支持 1m / 5m / 15m / 30m / 1h / 4h / 1d。没有推送、历史缺口或读取失败时保留缺失状态，不生成模拟行情。只订阅最近使用的合约，并限制连接内合约数量。

手动预览及确认独立核验本交易所的当前合约身份、分类和数量单位，不依赖第三方 Binance 目录在线；双腿另行核对可比性，Monitor 机会仍保留原有独立身份校验。Gate 原生盘口启用小数张数，避免小额档位被来源取整为零。

Monitor 的现货/充提筛选可选。开启时其机会预览及确认都重新读取当前资格；机会撤回、屏蔽、证据过期、合约变化或来源缺失会阻止该机会开仓。已收到筛选策略的连接，不接受后续丢失策略的数据。独立手动订单由用户自己选择合约，不使用 Monitor 机会资格。

公共盘口超过 10 秒、未来超过 1 秒或双腿不同步超过 5 秒时不能下单。目录每 5 分钟刷新，失败最多使用 15 分钟缓存。USDC / USD 按可用汇率检查开仓预算；平仓缺少换算汇率时仍可按原生合约数量减仓，同时不显示 USDT 名义额。

毛价差为 `(空腿买一 / 多腿卖一 − 1) × 10000 bp`。预算净价差扣除四次手续费与四次滑点；深度预览均价包含入场滑点，因此只额外保留退出滑点预算。1 bp = 0.01%。

## 旧版本升级

生产入口已移除模拟盘与自动交易。旧模拟表和配置保留，不再执行、展示或转换成真实持仓；旧 `/api/open`、`/api/close`、`/api/execution` 返回 410。历史模拟模块仅用于兼容性测试，不被生产入口加载。

升级不会自动连接账户或发送订单。Monitor 配置与模块 Basic 密码保留，Gate CrossEx 凭据需在界面配置。旧自动开平仓、止盈止损、分批修复等字段不进入生产执行链。

## 开发与验证

Windows 原生 Node 24.15.0+：

```powershell
npm ci
npm run check
npm test
npm run build
npm start
```

开发页面 `npm run dev`（5174），后台 `npm run dev:server`（3200）；分离开发设 `PUBLIC_ORIGIN=http://127.0.0.1:5174`。直接通过 HTTPS 代理时设置实际 HTTPS 来源，并在工作台设置相同“登录来源地址”。默认数据在忽略目录 `.data/`。

测试使用隔离数据库、假交易接口和确定性行情，不使用真实账户。Linux 验证由 Ubuntu CI 承担，不使用 WSL。测试通过不等于用户服务器已部署或真实账户已完成交易验收。

## 官方接口与摘要

2026-10-08 核对 [Gate CrossEx 中文说明](https://www.gate.com/docs/developers/crossex/zh_CN/) 与 [CrossEx API v4](https://www.gate.com/docs/developers/apiv4/en/crossex/)。私有请求固定发往 `https://api.gateio.ws/api/v4`，使用 KEY、Timestamp、SIGN；订单数量为基础币数量，不额外乘合约面值。价格另遵守 [Hyperliquid 精度规则](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/tick-and-lot-size)。

页面使用 `/api/live/instruments`、`/api/live/market`、`/api/live/preview`、`/api/live/confirm`、`/api/live/cancel` 与 `/api/live/requests/:id`。全部交易请求均须模块认证、同源和 CSRF 校验；行情接口只读。凭据不进入浏览器响应、公共 WebSocket 或第三方原生行情请求。

`GET /api/hub/summary?schemaVersion=2` 返回真实持仓条数、活动订单数、待确认订单数及账户快照健康状态，不重新生成完整页面，不纳入旧模拟盈亏。HTML 与 API 为 no-store，带内容哈希的构建资源采用 immutable 缓存。
