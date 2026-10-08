# 部署、配置与恢复

使用 README 中的一键命令安装或升级。独立交易终端无需 Monitor；需要价差机会时先更新 Monitor（提供 opportunities-v2），再更新 CrossEx。已保存的登录和配置保留，旧模拟记录留存但不再执行或展示。默认只监听 `127.0.0.1:3200`，使用专用系统用户 `gate-crossex-arbitrage`，与原项目端口、配置和数据分离。版本目录包含 AGPL 许可及参考来源说明，界面提供公开源代码链接。

| 路径 | 用途 |
| --- | --- |
| `/etc/gate-crossex-arbitrage.env` | 环境配置，重复安装保留 |
| `/var/lib/gate-crossex-arbitrage/` | SQLite 数据库和凭据加密密钥 |
| `/opt/gate-crossex-arbitrage/current` | 当前程序版本 |
| `/opt/gate-crossex-arbitrage/previous` | 上一个健康版本 |
| `/opt/gate-crossex-arbitrage/cache` | 依赖、构建与验证缓存 |
| `/opt/gate-crossex-arbitrage/.last-successful.env` | root 可读的上次健康配置 |
| `/etc/systemd/system/gate-crossex-arbitrage.service` | 自动管理的服务 |

环境文件采用无引号 `KEY=value`。支持 `HOST`、`PORT`、`DATA_DIR`、`NODE_ENV` 和可选 `PUBLIC_ORIGIN`。可选 `INITIAL_PASSWORD` 仅首次建库时使用，后续不会覆盖已保存密码。Gate CrossEx API Key / Secret 在界面中连接，不写入环境文件。

Monitor 登录信息、Gate CrossEx 凭据与手动交易参数在界面保存；密码和交易密钥由服务器 AES-256-GCM 加密，状态接口不返回密钥。后台只查询账户和订单，交易写请求必须来自手动确认或撤单。Monitor 来源读取与目录使用 GET，Hyperliquid 行情使用只读 info POST，Kraken / Lighter 使用单次公开 WebSocket；来源重定向被拒绝。外部盘口目标固定，Monitor 来源只接受回环地址。通常继续复用工作台 SSH 通道即可。直接通过 HTTPS 反向代理访问时须设置 `PUBLIC_ORIGIN=https://实际域名`，并让反向代理保留请求 Host；同时使用工作台代理时，把工作台该项目的“登录来源地址”设置为相同来源。默认 HTTP / SSH 代理部署留空。

配置示例：

```dotenv
HOST=127.0.0.1
PORT=3200
DATA_DIR=/var/lib/gate-crossex-arbitrage
NODE_ENV=production
```

修改后重复运行安装命令。`DATA_DIR` 必须在 `/var/lib/gate-crossex-arbitrage`、`/srv/gate-crossex-arbitrage/` 子目录或 `/opt/gate-crossex-arbitrage-data` 范围内；更换目录前迁移完整数据，不会自动搬迁。

安装器分别比较依赖、类型检查、行为测试、前端构建、运行代码和服务配置。无变化且健康时快速完成；仅文档变化不验证、不构建、不重启；仅测试变化在隔离目录验证，不创建发布目录或重启。后端变化只重新执行行为测试，复用类型检查和前端产物；配置变化直接复用当前程序目录。安装器和 CI 在独立类型检查后运行纯构建 `build:bundle`，不重复执行类型检查；开发默认 `npm run build` 仍包含类型检查。首次采用新缓存格式会保守验证和构建一次。

依赖安装后由 root 持有且禁止其他用户写入，隔离验证与构建目录只链接顶层包，Vite 临时文件留在该目录。生产发布通过软链接使用同一只读依赖缓存，保留 ws、decimal.js 等运行依赖；版本清理不删除这些依赖缓存。无需复制依赖树或反复执行递归权限调整。构建、验证成功后分别原子记录缓存；测试或构建失败不切换现有服务。已检查的远端提交与 `.source-sha` 中的实际运行产物版本分开记录，文档和测试变化不会改写旧产物版本。

Ubuntu CI 同时覆盖隔离安装状态机和真实非 root 的只读依赖构建、后端包解析；Windows 运行应用类型检查、测试和构建。新程序启动失败恢复旧链接、systemd 和上次健康配置；失败的新环境文件另存 `.failed-时间-PID`。不会回滚或删除数据库。

查看状态：

```bash
sudo systemctl status gate-crossex-arbitrage
sudo journalctl -u gate-crossex-arbitrage -f
```

重置模块 Basic 密码（用户名始终为 `admin`）：

```bash
sudo -u gate-crossex-arbitrage env DATA_DIR=/var/lib/gate-crossex-arbitrage "$(cat /opt/gate-crossex-arbitrage/.node-path)" /opt/gate-crossex-arbitrage/current/server/setup.mjs --reset-password
```

新密码保存后旧认证失效；更新工作台保存的本模块凭据。浏览器可能需要关闭原页面再重新打开。修改数据目录时对应调整命令。

备份前停止服务，备份整个数据目录和环境文件，再启动服务。必须同时保留 `crossex.sqlite`、可能存在的 WAL 文件与 `credentials.key`。缺失加密密钥时服务会拒绝打开已有数据库。旧模拟记录保留但不参与实盘。重启后只读核对已提交或未知订单，不重发订单、不恢复未发送的腿。同一数据目录的第二实例不能执行交易。

`/api/health` 只表示本地服务可运行；Monitor 或交易所连接状态以界面和摘要为准，不能用健康检查成功证明行情或策略可执行。

Kraken 公开盘口需要服务器可连接 `wss://futures.kraken.com/ws/v1`，Lighter 需要 `wss://mainnet.zklighter.elliot.ai/stream`。当前 CrossEx WebSocket 使用直连；连接失败会阻止相关订单预览，不使用本地时间冒充盘口时间。私有账户读取与交易需要访问 https://api.gateio.ws/api/v4/crossex/。
