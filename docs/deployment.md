# 部署、配置与恢复

使用 README 中的一键命令安装或升级。默认只监听 `127.0.0.1:3200`，使用专用系统用户 `gate-crossex-arbitrage`，与原项目端口、配置和数据分离。

| 路径 | 用途 |
| --- | --- |
| `/etc/gate-crossex-arbitrage.env` | 环境配置，重复安装保留 |
| `/var/lib/gate-crossex-arbitrage/` | SQLite 数据库和凭据加密密钥 |
| `/opt/gate-crossex-arbitrage/current` | 当前程序版本 |
| `/opt/gate-crossex-arbitrage/previous` | 上一个健康版本 |
| `/opt/gate-crossex-arbitrage/cache` | 依赖、构建与验证缓存 |
| `/opt/gate-crossex-arbitrage/.last-successful.env` | root 可读的上次健康配置 |
| `/etc/systemd/system/gate-crossex-arbitrage.service` | 自动管理的服务 |

环境文件采用无引号 `KEY=value`。支持 `HOST`、`PORT`、`DATA_DIR`、`NODE_ENV` 和可选 `PUBLIC_ORIGIN`。可选 `INITIAL_PASSWORD` 仅首次建库时使用，后续不会覆盖已保存密码。不要在这里填写交易所密钥；此版本不使用它们。

Monitor 登录信息与模拟参数在模块界面保存；用户名、服务地址是配置，密码由服务器 AES-256-GCM 加密，公开状态接口不会返回密码。目录/行情获取全部使用 GET，来源重定向被拒绝。外部盘口目标固定，Monitor 来源只接受回环地址。通常继续复用工作台 SSH 通道即可。直接通过 HTTPS 反向代理访问时须设置 `PUBLIC_ORIGIN=https://实际域名`，并让反向代理保留请求 Host；同时使用工作台代理时，把工作台该项目的“登录来源地址”设置为相同来源。默认 HTTP / SSH 代理部署留空。

配置示例：

```dotenv
HOST=127.0.0.1
PORT=3200
DATA_DIR=/var/lib/gate-crossex-arbitrage
NODE_ENV=production
```

修改后重复运行安装命令。`DATA_DIR` 必须在 `/var/lib/gate-crossex-arbitrage`、`/srv/gate-crossex-arbitrage/` 子目录或 `/opt/gate-crossex-arbitrage-data` 范围内；更换目录前迁移完整数据，不会自动搬迁。

安装器先比较远端版本、运行时和配置。无变化且健康时快速完成；仅文档变化不重建应用；依赖和前端按各自内容缓存。首次或相关内容变化时执行类型检查、行为测试、页面构建和健康检查。新程序启动失败恢复旧链接、systemd 和上次健康配置；失败的新环境文件另存 `.failed-时间-PID`。不会回滚或删除数据库。

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

备份前停止服务，备份整个数据目录和环境文件，再启动服务。必须同时保留 `crossex.sqlite`、可能存在的 WAL 文件与 `credentials.key`。缺失加密密钥时服务会拒绝打开已有数据库。模拟记录不会自动清空；自动模拟启停状态在重启后保留。

`/api/health` 只表示本地服务可运行；Monitor 或交易所连接状态以界面和摘要为准，不能用健康检查成功证明行情或策略可执行。
