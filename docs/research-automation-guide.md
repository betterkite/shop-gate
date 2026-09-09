# 【金融域遗留 · 已归档】投研情报中心与日报自动化指南

> **本文档描述的是金融投研情报中心与投研日报自动化（观察池/研报/推送），其评测与数据体系已随金融域移除。**
>
> 零售域的对应能力是 **[经营情报中心（/operations-briefing 路由，零售版）](architecture.md)**（经营日报/类目经营榜/观察池）与可运行的零售日报链路（`POST /api/commerce/briefing/daily`）。
> 本文档仅保留作历史参考。

---

# 投研情报中心与日报自动化指南（历史参考摘要）

本文只保留金融域投研日报自动化的历史事实摘要，完整实现已随金融域移除，不再维护。

- 旧链路：投研情报中心（`/research-reports` 路由）串起观察池、证据采样、报告契约与推送回执；观察池默认绑定 `a-share-sample-research-pool`。
- 旧数据模型：`research_watchlists`、`research_reports`、`research_report_runs` 等表已从 `prisma/schema.prisma` 移除。
- 旧 API：`GET/POST /api/research/reports`（`run-daily-report` / `send-latest-report`）。
- 旧推送：企业微信/飞书/钉钉/Discord webhook adapter，由 `SHOPGATE_WXWORK_RESEARCH_WEBHOOK` 等环境变量配置。

零售域对应能力的现状（以事实基线为准）：

- 页面：经营情报（`/operations-briefing`），含经营日报、类目经营榜与观察池视图。
- 数据层：`src/lib/commerce/retail-briefing.ts`（/summary + /categories/top + /items）。
- 生成持久化：`src/lib/commerce/retail-daily-report.ts` → `OperationBriefRun(completed)` + `OperationBrief`；观察池模型为 `BriefWatchPool`。
- API：`GET/POST /api/commerce/briefing/daily`；页面提供“生成今日日报”按钮与最近生成日报。
- 边界：日报推送回执的通知渠道尚未接入，属待办项。

除上述零售链路外，请勿把本文中的旧路由、旧表或旧 API 当作现状使用。
