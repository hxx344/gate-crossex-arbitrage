# Lessons from merged work

这里保存 gate-crossex-arbitrage 的合并经验。改动前先读本文件。每条先给加粗祈使规则，再给证据（SHA / 现象），结尾 `Seen N× (日期…)`。满 3 个不同复盘日迁入 [docs/code-standards.md](docs/code-standards.md) 并在此留 Moved 索引。

## Database

**交易持久化路径通过共享 statement cache 复用编译结果；缓存的是 Statement，不是查询结果。**

- 证据：`281813a2` 新增 `server/statement-cache.mjs`，`store`/`engine`/`analytics`/`live-runtime` 改走 `store.prepare`；`tests/statement-cache.test.mjs`。
- Seen 1× (2026-10-13)

## Delivery / Workspace

**功能合入独立仓库后，还须同步到用户实际运行的入口（如工作台内嵌模块），不能只凭独立仓绿测与发布判定交付完成。**

- 证据：`640df2f8` 在本仓已发布资金费机会；同日工作台仍加载旧内嵌模块直至 project-aggregation `e74c9034` 移植。详见上游工作台 LESSONS L017。
- Seen 1× (2026-10-14)

## Trading UX

**下单票旁展示可开容量与杠杆，避免交易员在看不到额度时提交。**

- 证据：`804d284e` 新增 `open-capacity` 服务端与 `OpenCapacityPanel`；`tests/open-capacity.test.mjs`、`tests/open-capacity-ui.test.mjs`。
- Seen 1× (2026-10-13)

资金费机会表接到手动对冲面板（`640df2f8`），纯功能交付，无缺陷类教训；交付路径见上方 Delivery / Workspace。

## Theme / docs

本窗口另有 `f7b52a16`（深色主题），纯样式，无缺陷类教训。

## Moved to the code standards

尚无。
