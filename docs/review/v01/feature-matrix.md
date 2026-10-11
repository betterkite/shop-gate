# v0.1 完整功能对照表

固定参考 revision：`60feefd81e255b3b1f63ebd0cb6aa7d22d525ba5`。产品盘点起点：`ad448dae431dcb5b6be30d6d0cfc695da1be1082`。

本表每行是必须交付的业务验收项，不是已完成能力清单。**所有行初始状态均为待实现/待重新验证，实际代码/API 与通过证据均待补**；现有代码只能候选承接。状态变更按 [验收协议](acceptance.md) 逐行登记，最终必须达到 100% 必需项验收通过。

“R1→R7”等表示先建立底座，再在后续阶段验收，不允许先把底座通过当作页面也通过。表中的模块与 API 是目标职责，不表示已存在的新路由。

## 来源定位

全部参考定位以下列固定 revision 文件及符号为准。测试名称只证明场景存在，不代表本项目测试已执行。

| 编号 | 固定来源与定位 |
| --- | --- |
| S1 | [analytics.tsx](https://github.com/tiammomo/ecommerce-bi-workbench/blob/60feefd81e255b3b1f63ebd0cb6aa7d22d525ba5/apps/web/src/pages/analytics.tsx)：Overview、Channels、Stores、Products、Profit、Coverage、Trend |
| S2 | [analytics-panels.tsx](https://github.com/tiammomo/ecommerce-bi-workbench/blob/60feefd81e255b3b1f63ebd0cb6aa7d22d525ba5/apps/web/src/pages/analytics-panels.tsx)：StoreRanking、ChannelTrends、ChannelExpenses |
| S3 | [refunds.tsx](https://github.com/tiammomo/ecommerce-bi-workbench/blob/60feefd81e255b3b1f63ebd0cb6aa7d22d525ba5/apps/web/src/pages/refunds.tsx)：Refunds |
| S4 | [costs.tsx](https://github.com/tiammomo/ecommerce-bi-workbench/blob/60feefd81e255b3b1f63ebd0cb6aa7d22d525ba5/apps/web/src/pages/costs.tsx)：Costs |
| S5 | [reports.tsx](https://github.com/tiammomo/ecommerce-bi-workbench/blob/60feefd81e255b3b1f63ebd0cb6aa7d22d525ba5/apps/web/src/pages/reports.tsx)：Reports |
| S6 | [details.tsx](https://github.com/tiammomo/ecommerce-bi-workbench/blob/60feefd81e255b3b1f63ebd0cb6aa7d22d525ba5/apps/web/src/features/details.tsx)：DetailDrawer、DetailInsights、MappingManager、TargetsDrawer、HelpDrawer |
| S7 | [context.tsx](https://github.com/tiammomo/ecommerce-bi-workbench/blob/60feefd81e255b3b1f63ebd0cb6aa7d22d525ba5/apps/web/src/app/context.tsx)、[filters.tsx](https://github.com/tiammomo/ecommerce-bi-workbench/blob/60feefd81e255b3b1f63ebd0cb6aa7d22d525ba5/apps/web/src/components/bi/filters.tsx)、[table.tsx](https://github.com/tiammomo/ecommerce-bi-workbench/blob/60feefd81e255b3b1f63ebd0cb6aa7d22d525ba5/apps/web/src/components/bi/table.tsx)、[app.tsx](https://github.com/tiammomo/ecommerce-bi-workbench/blob/60feefd81e255b3b1f63ebd0cb6aa7d22d525ba5/apps/web/src/app/app.tsx)：公共范围、列表与八页导航 |
| S8 | [main.py](https://github.com/tiammomo/ecommerce-bi-workbench/blob/60feefd81e255b3b1f63ebd0cb6aa7d22d525ba5/apps/api/app/main.py)：analytics、orders、refunds、costs、cost-history、operations、mappings、targets、report-views、reports/export、expenses、demo/reset |
| S9 | [domain.py](https://github.com/tiammomo/ecommerce-bi-workbench/blob/60feefd81e255b3b1f63ebd0cb6aa7d22d525ba5/apps/api/app/domain.py)、[analytics.py](https://github.com/tiammomo/ecommerce-bi-workbench/blob/60feefd81e255b3b1f63ebd0cb6aa7d22d525ba5/apps/api/app/analytics.py)、[operations.py](https://github.com/tiammomo/ecommerce-bi-workbench/blob/60feefd81e255b3b1f63ebd0cb6aa7d22d525ba5/apps/api/app/operations.py)：核算、全范围聚合与操作 |
| S10 | [csv_spec.py](https://github.com/tiammomo/ecommerce-bi-workbench/blob/60feefd81e255b3b1f63ebd0cb6aa7d22d525ba5/apps/api/app/csv_spec.py)、[imports.py](https://github.com/tiammomo/ecommerce-bi-workbench/blob/60feefd81e255b3b1f63ebd0cb6aa7d22d525ba5/apps/api/app/imports.py)：十二类模板、预览、提交、标准数据导出、批次、错误 |
| S11 | [test_domain.py](https://github.com/tiammomo/ecommerce-bi-workbench/blob/60feefd81e255b3b1f63ebd0cb6aa7d22d525ba5/apps/api/tests/test_domain.py)、[test_csv_imports.py](https://github.com/tiammomo/ecommerce-bi-workbench/blob/60feefd81e255b3b1f63ebd0cb6aa7d22d525ba5/apps/api/tests/test_csv_imports.py)：核算/事务/往返测试场景 |
| S12 | [tests/e2e](https://github.com/tiammomo/ecommerce-bi-workbench/tree/60feefd81e255b3b1f63ebd0cb6aa7d22d525ba5/tests/e2e)、[cli.py](https://github.com/tiammomo/ecommerce-bi-workbench/blob/60feefd81e255b3b1f63ebd0cb6aa7d22d525ba5/apps/api/app/cli.py)、[seed_data.py](https://github.com/tiammomo/ecommerce-bi-workbench/blob/60feefd81e255b3b1f63ebd0cb6aa7d22d525ba5/apps/api/app/seed_data.py)：浏览器、持久化、迁移、备份、演示 |
| G | 用户批准的完整 v0.1 Goal：Shop Gate 主题、PostgreSQL、多工作空间授权、Agent、规模、迁移和交付要求；不是参考项目自有能力 |

## 1. 经营总览

| ID | 必须交付 | 来源 | 阶段 | 验收方法 |
| --- | --- | --- | --- | --- |
| OV01 | 净销售额、已核算贡献利润、付款订单数、付款客单价、利润率、退款金额占比 | S1 Overview；S9 | R1→R3 | 固定账本逐笔复算；六指标与 API/导出一致 |
| OV02 | 等长前期比较；零/负基数、历史不足不伪造增长率 | S1；S9 | R1→R3 | 正/零/负基数及缺历史场景 |
| OV03 | 按日/周销售与利润趋势；选择期间查看依据 | S1 Trend | R3 | 日期边界/时区/周起点和图表点击浏览器验收 |
| OV04 | 渠道贡献、收入/利润切换及占比 | S1 Overview | R3 | 负值、零分母、渠道汇总与整体核对 |
| OV05 | 经营关注、变化事实、来源明细及继续分析 | S1 Overview；S6 | R3 | 每条关注能打开同范围明细；不宣称未经证实因果 |
| OV06 | 月度目标与完成度；独立自然月而非当前筛选期间 | S1；S6 TargetsDrawer | R3 | 切换月份/范围、目标维护和重启恢复 |
| OV07 | 数据截止时间、来源、未核算收入/订单与核算覆盖 | S1 Coverage；S8 meta | R1→R3 | 缺成本/映射/汇率不是零；覆盖率分母可查 |

## 2. 渠道对比

| ID | 必须交付 | 来源 | 阶段 | 验收方法 |
| --- | --- | --- | --- | --- |
| CH01 | 拼多多、Temu 半托管、1688 等平台模型；币种/市场/模式 | S8 meta；S10 stores | R1→R4 | 模型及演示平台有差异，正式导入不虚构费率 |
| CH02 | 各平台销售、利润、利润率、订单/客单价、费用和退款 | S1 Channels | R4 | 分组与总体精确核对，比例重算 |
| CH03 | 横向对比、收入与利润关联图 | S1 Channels | R4 | 图表单位/图例、负利润与缺失值正确 |
| CH04 | 渠道趋势及指标切换；点击期间与平台 | S2 ChannelTrends | R4 | 切换指标保留筛选，点击可撤销 |
| CH05 | 渠道商品成本与各项费用；保留负费用调整 | S2 ChannelExpenses | R4 | 显式调整与已核算范围说明 |
| CH06 | 平台内店铺、商品、订单与费用详情 | S6 DetailDrawer | R4 | 跨模块关联保持日期/平台/数据版本 |
| CH07 | 完整平台表格，搜索、排序、全量访问与导出 | S1 Channels；S7 | R4 | 非当前页汇总、服务端分页、完整 CSV |

## 3. 店铺分析

| ID | 必须交付 | 来源 | 阶段 | 验收方法 |
| --- | --- | --- | --- | --- |
| ST01 | 店铺经营排名图与全量排名表 | S1 Stores；S2 StoreRanking | R4 | 排序过滤在分页之前；摘要标注查看全部 |
| ST02 | 销售、利润、利润率、订单、退款、前期比较 | S1 Stores | R4 | 单店及全店复算、无可比基数说明 |
| ST03 | 月度目标查询、修改、进度及持久化 | S6 TargetsDrawer；S8 targets | R3→R4 | 权限/确认/版本冲突；重启后不丢失 |
| ST04 | 店铺详情：KPI、日/周趋势、相关商品与平台信息 | S6 DetailDrawer/DetailInsights | R4 | 当前对象及范围一致 |
| ST05 | 完整订单明细、订单行、成本/退款/费用证据 | S6；S8 orders | R4 | 订单去重，全量列表与行证据 |
| ST06 | 全量店铺费用及退款明细 | S6；S8 expenses/refunds | R4→R5 | 未分摊/负费用、两种退款口径 |
| ST07 | 平台约束店铺选择，搜索/排序/分页/关联导航 | S7 | R4 | 无效平台店铺组合拒绝或明确清除，不跨权限 |

## 4. 商品分析

| ID | 必须交付 | 来源 | 阶段 | 验收方法 |
| --- | --- | --- | --- | --- |
| PD01 | 商品、标准规格（SKU）、平台商品三个粒度 | S1 Products | R4 | 同一事实表各粒度汇总一致 |
| PD02 | 畅销、高贡献、负贡献、低利润率、高退款、待核算筛选 | S1 Products | R4 | 全范围筛选后分页，规则中文说明 |
| PD03 | 热销摘要、销售与利润率分布，完整列表入口 | S1 Products | R4 | 摘要不能冒充全量；未核算点不显示零利润率 |
| PD04 | 覆盖平台/店铺数、标准销量、单位售价、历史加权单位成本 | S1 Products | R1→R4 | 单位换算/权重/成本快照逐行复算 |
| PD05 | 同款跨店铺/平台比较，关联订单、退款和费用 | S6 | R4 | 对象与筛选范围一致；完整明细 |
| PD06 | 标准规格与平台编码映射完整查询、状态与搜索 | S6 MappingManager；S8 mappings | R4 | 前导零编码，缺映射可查，服务端分页 |
| PD07 | 映射/单位换算维护预览、确认、版本及审计 | S6；S9 operations | R4 | 无确认不写入、并发/过期/幂等校验 |
| PD08 | 缺映射修复不隐式改历史；显式历史重算关联 | S9；S11 | R4→R5 | 历史快照不变；确认重算后覆盖变化可核对 |
| PD09 | 各店铺当前继承成本、来源层级、历史版本与成本管理入口 | S6 DetailDrawer | R4→R5 | 当前版本与历史订单成本分开显示 |
| PD10 | 全量商品列表默认20条，搜索/排序/分页/全量导出 | S1 Products；S7 | R4 | 1000规格可全访问，汇总不取当前页 |

## 5. 利润与费用

| ID | 必须交付 | 来源 | 阶段 | 验收方法 |
| --- | --- | --- | --- | --- |
| PF01 | 收入→退款→成本→各费用→贡献利润完整形成图 | S1 Profit | R5 | 各步精确相加，负值/净收入负值可展示 |
| PF02 | 平台/包装/商家物流/广告费用独立查询及占比 | S1 Profit；S8 expenses | R5 | 真实账本值、不以模拟费率替正式支出 |
| PF03 | 前后期间金额变化拆解与桥接图 | S1 Profit；S9 | R5 | 差额等于各因素之和；算术解释非业务因果 |
| PF04 | 按平台/店铺/商品等分组利润表、完整明细 | S1 Profit | R5 | 过滤/分组/整体一致，未知利润明确 |
| PF05 | 费用来源、分摊依据、订单/商品关联及负调整 | S6；S8 expenses | R1→R5 | 完整源范围先分摊再筛选；稳定余数分配 |
| PF06 | 未分摊费用单列，整体/店铺承担但不伪归属SKU | S9；S11 | R1→R5 | 无销售仍有费用、商品总和差额解释 |
| PF07 | 已核算/待核算收入与费用、贡献利润覆盖范围 | S1 Coverage；S9 | R5 | 不能冒充包含固定支出的净利润 |

## 6. 退款与售后

| ID | 必须交付 | 来源 | 阶段 | 验收方法 |
| --- | --- | --- | --- | --- |
| RF01 | 付款订单归属与退款发生时间两种独立口径 | S3 Refunds；S9 | R1→R5 | 跨期退款；事件口径不拿当期收入作退款率分母 |
| RF02 | 已完成退款金额、去重关联订单、合适分母的退款比例 | S3 | R5 | 待处理排除、零分母/无分母显示未知 |
| RF03 | 原因分布/类型图；点击筛选与撤销 | S3 | R5 | 图表、KPI、明细、导出范围相同 |
| RF04 | 仅退款、退货退款、未发货取消及部分退款 | S3；S9 | R1→R5 | 累计金额/数量约束和多次退款 |
| RF05 | 可回收数量与原成本快照冲回；费用不自动清零 | S9；S11 | R1→R5 | 不退货保持成本，部分回收仅冲对应数量 |
| RF06 | 完整退款表、原因/类型/搜索/排序/分页及导出 | S3；S8 refunds | R5 | 筛选和排序在分页之前，非当前页导出 |
| RF07 | 退款事件→原订单→订单行/商品/店铺证据 | S6 | R5 | 对象存在、权限一致、原币/折算金额可追溯 |

## 7. 报表中心

| ID | 必须交付 | 来源 | 阶段 | 验收方法 |
| --- | --- | --- | --- | --- |
| RP01 | 日报、平台、店铺、商品、订单、退款、成本变更七类报表 | S5 Reports；S8 reports/export | R6 | 每类明确粒度/来源/口径，不空页冒充成功 |
| RP02 | 搜索、范围、全量分页、排序、显示列 | S5 | R6 | 列表及导出按相同过滤/排序，不截取当前页 |
| RP03 | 保存/恢复视图的报表类型、筛选、列和排序 | S5；S8 report-views | R6 | 刷新、清浏览器缓存和服务重启仍存在 |
| RP04 | 保存视图重命名、删除及权限冲突保护 | S5；S8 | R6 | 非所有者操作拒绝，受控删除留审计 |
| RP05 | 分析报表 CSV 全范围导出及公式注入保护 | S8 reports/export；S11 | R6 | 汉字/负金额/引号/换行、安全打开表格 |
| RP06 | 当前成本与成本变更分别导出 | S4；S8 costs/cost-changes | R5→R6 | 当前生效成本≠变更记录；二者均不截页 |
| RP07 | 标准数据导出可往返，与展示报表用途区分 | S10 imports/export | R2→R6 | 十二类导出再导入无值损失，不改变ID |
| RP08 | 导入中心：模板说明、多文件上传、预览、错误下载与确认 | S5；S10 | R2→R6 | 先预览不写账本，失败明确修正路径 |
| RP09 | 导入批次、文件摘要、模板/操作状态、批次错误详情 | S5；S10 | R2→R6 | 全量访问、重启持久化、私有原文不公开 |

## 8. 商品成本管理

| ID | 必须交付 | 来源 | 阶段 | 验收方法 |
| --- | --- | --- | --- | --- |
| CT01 | 基础/平台/店铺规格成本、来源与继承明细 | S4 Costs；S9 | R1→R5 | 店铺>平台>基础，三层不相加 |
| CT02 | 按生效日期查询；全量列表、搜索、排序、分页和批量选择 | S4 | R5 | 销售期间与成本查看日期区别可见 |
| CT03 | 成本版本/生效区间/来源说明/变更与历史 | S4；S8 cost-history | R5 | 不重叠、未来版本不改历史快照 |
| CT04 | 新增或调整单规格成本及层级作用范围 | S4 | R5 | 输入精度/范围校验、预览与确认 |
| CT05 | 批量固定值、金额增减、百分比增减 | S4 | R5 | 全批精度、非负/溢出、作用范围及事务 |
| CT06 | 影响预览：变更前后、涉及对象、覆盖/利润差异 | S9 make_preview | R5 | 预览不写账本，数值可复算 |
| CT07 | 只读试算、标准单位及利润变化对照 | S4；S9 | R5 | 账本/版本/快照保持不变 |
| CT08 | 缺成本/映射/汇率修复后的显式历史重算 | S4；S9 recalc_candidates | R5 | 所选范围/仅缺失与全部选项、确认后更新 |
| CT09 | 提交幂等、键冲突、预览过期、版本并发保护 | S9 commit_operation；S11 | R1→R5 | 双客户端竞争仅一成功，整批回滚 |
| CT10 | 操作记录、影响对象、操作者、来源和可核对审计 | S4；S8 operations | R5 | 全量可访问，不把“最近100条”当完整历史 |

## 9. 十二类标准 CSV（每类都是独立必需项）

所有类必须同时通过模板下载、字段说明、精度/引用/唯一键检查、预览/确认、重复/冲突、错误下载、批次、导出再导入，不只是注册一个文件名。

| ID | 模板与关键语义 | 来源 | 阶段 | 验收方法 |
| --- | --- | --- | --- | --- |
| IO01 | channels：销售平台身份/名称 | S10 SPECS channels | R2 | 标准平台导入往返 |
| IO02 | stores：平台、市场、模式、原币、时区 | S10 SPECS stores | R2 | 平台依赖、非法时区/币种与往返 |
| IO03 | products：商品、类目、系列 | S10 SPECS products | R2 | 中文名称、前导零、往返 |
| IO04 | skus：标准规格、商品引用、单位 | S10 SPECS skus | R2 | 商品依赖与标准单位 |
| IO05 | mappings：店铺平台商品/规格、标准规格、倍数、状态 | S10 SPECS mappings | R2 | 店铺+平台编码唯一、4位数量精度 |
| IO06 | fx_rates：原币、业务日期、汇率、来源 | S10 SPECS fx_rates | R2 | 8位精度、缺汇率待核算，不伪造1 |
| IO07 | costs：分层成本、生效区间、备注 | S10 SPECS costs | R2 | 4位成本精度、版本区间与历史快照 |
| IO08 | orders：平台订单/店铺、付款时间、状态、原币/汇率 | S10 SPECS orders | R2 | 复合唯一、未付款不计成交 |
| IO09 | order_lines：订单/平台规格、数量/倍数、商品实收原币金额 | S10 SPECS order_lines | R2 | 订单引用、2位金额、单位换算 |
| IO10 | refunds：订单行、完成时间、金额、类型、原因、数量/可回收量 | S10 SPECS refunds | R2 | 累计上限、跨币种部分/全额退款 |
| IO11 | expenses：店铺/日期/科目、正负原币金额、汇率、订单/行与来源 | S10 SPECS expenses | R2 | 负调整、依赖一致、无销售费用 |
| IO12 | targets：店铺、月份、目标金额 | S10 SPECS targets | R2 | 店铺月份唯一与重启持久化 |

## 10. 公共交互与数据交换

| ID | 必须交付 | 来源 | 阶段 | 验收方法 |
| --- | --- | --- | --- | --- |
| UX01 | 八个业务入口、统一导航，独立对话与受权限保护的管理入口 | S7；G | R3→R7 | 八页实际操作，不反复跳成果页 |
| UX02 | 日期/平台/店铺/商品/类目/搜索/排序/页码进入URL与统一上下文 | S7；G | R3→R7 | 链接/刷新/前后退恢复 |
| UX03 | 店铺受平台约束，图表联动可撤销、关联详情保留范围 | S7；S6 | R3→R7 | 跨页+撤销+权限测试 |
| UX04 | 全量列表服务端分页默认20，过滤/排序先于分页，稳定排序 | S7；G | R1→R7 | 数据超多页，无漏项/重复，页码越界正确 |
| UX05 | 翻页/排序/详情不跳顶部；摘要有查看全部和范围说明 | S7；G | R3→R7 | 滚动位置及摘要全量入口浏览器验收 |
| UX06 | Shop Gate 青蓝/深浅色，先总览与商品详情视觉样板 | G | R3→R7 | 两主题视觉审核，小屏不遮重要操作 |
| UX07 | 中文优先、缩写释义、诊断有事实/证据/下一步 | S6 HelpDrawer；G | R3→R7 | 页面及助手文案审查 |
| UX08 | 加载、错误、重试、无权限、空数据、真实零与未知区分 | S7 QueryState；G | R3→R7 | 失败注入、重试，不用兜底假数据 |
| UX09 | 十二类多文件依赖排序、预览不写入、整批事务回滚 | S10；S11 | R2 | 跨文件依赖和后段失败无部分提交 |
| UX10 | 同记录跳过、同键异内容冲突、请求幂等与版本不空增 | S10；S11 | R2 | 重复导入及同幂等键不同请求拒绝 |
| UX11 | UTF-8/BOM/中文/引号/换行/前导零，有限十进制精度 | S10；S11 | R2 | CSV边界固定集，不静默截断或浮点损失 |
| UX12 | 上传文件/行数/耗时限额，规范化暂存、过期预览与安全清理 | S10；G | R2 | 超额拒绝、过期不写、私有范围隔离 |
| UX13 | 导入成功版本递增、缓存失效、页面刷新、旧分析保留原版本 | G | R2→R6 | 并发读一致，不默认调用付费模型 |
| UX14 | 只读查看的报表导出与可重导入标准数据的安全策略分别定义 | S10；S11 | R2→R6 | 公式注入保护不损坏标准往返数据 |

## 11. 核算底座与维护

| ID | 必须交付 | 来源 | 阶段 | 验收方法 |
| --- | --- | --- | --- | --- |
| AC01 | 订单/行、退款、成本版本/快照、费用/分摊、映射/汇率/目标账本 | S9；G | R1 | PostgreSQL迁移/关联/事务/索引实测 |
| AC02 | 成交来自实收明细、订单去重、标准单位销量 | S9 | R1 | 金额不依赖行为次数/当前价格 |
| AC03 | 店铺>平台>基础并按付款时间匹配；不可变历史快照 | S9；S11 | R1 | 层级/区间/未来成本与历史独立 |
| AC04 | 仅退款保留成本；可回收量按原快照冲回；累计约束 | S9；S11 | R1 | 多次部分退款、全额/外币舍入一致 |
| AC05 | 完整源范围稳定分摊；精确余数；不能归属的费用单列 | S9；S11 | R1 | 各项和整体守恒，筛选不重新分配 |
| AC06 | 缺成本/映射/汇率保留未知、已核算范围与覆盖率 | S9 | R1 | unknown≠0，恢复后显式重算 |
| AC07 | 金额2位、成本/数量4位、汇率8位精确存储计算；API十进制字符串 | S9；S10；G | R1 | 溢出、非有限数、精度及边界固定集 |
| AC08 | 付款与退款时间口径、原币/折算及来源、汇总比率重算 | S9 | R1 | 时区/跨期/零负分母/外币一致 |
| AC09 | 统一指标目录：中文名、来源/公式/单位、维度/分母/缺失处理 | S6；G | R1 | 页面/导出/助手共用计算服务 |
| AC10 | 最近区间取数据集最新业务日，随机种子与日期独立 | G | R1→R2 | 多个日期/种子组合，不写死2026-09 |
| AC11 | 工作空间/数据集/权限/版本贯穿查询、缓存、导出、Agent | G | R1→R7 | 伪造身份、跨空间读写及泄露拒绝 |
| AC12 | 约1000规格、180天、多平台店铺，热点/长尾/活动/费用退款/未知场景 | S12；G | R2 | 确定性生成但非平直曲线，演示标签明确 |
| AC13 | 演示/正式隔离；初始化不重置；仅明确确认允许演示重置 | S8 demo/reset；G | R2→R7 | 正式模式禁止、重启不覆盖修改 |
| AC14 | 迁移、备份、恢复、操作持久化，重启目标/映射/成本/视图仍在 | S12；G | R1→R7 | PostgreSQL恢复演练，证据不借用SQLite测试 |
| AC15 | 请求ID、错误分类、readiness、审计、长操作状态与取消边界 | S8；G | R1→R7 | 故障/并发、敏感值不进日志 |

## 12. 嵌入式 Agent（目标新增，参考项目没有此能力）

| ID | 必须交付 | 来源 | 阶段 | 验收方法 |
| --- | --- | --- | --- | --- |
| AG01 | 八页嵌入经营分析助手，不默认生成整页看板/修改源码 | G | R3→R6 | 每页入口及操作；无无关代码产物 |
| AG02 | 继承页面范围、选中对象、工作空间、数据集/版本 | G | R3→R6 | 选中对象/切换范围与权限隔离 |
| AG03 | 分析步骤、受控指标/维度/过滤工具，模型不能直接执行任意SQL | G | R3 | 白名单、越权/注入、证据链 |
| AG04 | 事实答案+来源，排名全量表格，趋势/比较相关图表 | G | R3→R6 | 不硬套通用看板，分页/范围/数值可核对 |
| AG05 | 数据足够但展示不支持时继续问答/表格，不截断或跳页 | G | R3 | 模板不覆盖、用户只问答固定场景 |
| AG06 | 必要且最少澄清；默认当前范围可见，不要求内部ID | G | R3 | 默认提问完整；有效问题不重复澄清 |
| AG07 | 多轮“为什么下降/继续看这些商品”、比较与证据继承 | G | R3→R6 | 多轮固定集，工作空间/数据集切换隔离 |
| AG08 | 明确持续查看时保存结构化专题分析，统一主题渲染 | G | R6 | 原版本来源、重开与范围刷新，不写页面源码 |
| AG09 | 成本/映射/目标/导入/重算：预览→明确确认→受控提交 | G | R3→R6 | 权限/版本/幂等/过期；建议不等于授权 |
| AG10 | 模型接入、会话、审批、取消、预算、执行记录承接验收 | G | R3→R6 | 真实链路和故障恢复，不能只测Mock |
| AG11 | 模型不可用时基础BI正常；助手明确局部不可用 | G | R3→R7 | 关闭模型/超时，不伪造模型响应 |
| AG12 | ≥32固定场景，八模块每模块至少1例真实授权模型链路 | G | R3→R7 | 固定核算评估与真实模型证据分别记录 |

## 13. 迁移、安全、性能与最终交付

| ID | 必须交付 | 来源 | 阶段 | 验收方法 |
| --- | --- | --- | --- | --- |
| DL01 | 产品/工作台Git边界、正确RepoSteward连接、任务证据和独立PR | G | R0→R7 | 可信隔离验证、公开写入记录，不绕门禁 |
| DL02 | 旧商品运营/情报/分析链接迁移与历史会话/成果只读路径 | G | R3→R7 | 旧链接和用户历史实际回归 |
| DL03 | 旧模板/金融残留/无用资源有引用检查和可恢复清退记录 | G | R7 | 不误删数据/通用Agent能力，回归通过 |
| DL04 | 正式PG多客户端事务、权限、并发、持久化/恢复验收 | G | R1→R7 | 独立测试库，不能用Mock或SQLite代替 |
| DL05 | 1000规格/100000订单，普通查询p95≤3秒 | G | R7 | 机器/计划/缓存/资源/样本记录，导出重算不阻塞 |
| DL06 | 单元、后端、类型、lint、构建、文档、必要E2E及CI通过 | G | R0→R7 | 精确revision/快照和可信结果，不删测试降门禁 |
| DL07 | 安装/配置/模板/演示/迁移/备份恢复/部署完整交付 | S12；G | R7 | 新环境复现、凭据与私有会话不公开 |
| DL08 | 全项实现验收、阻断/高严重度问题清零，按授权合并后验收 | G | R7 | 没有部署证据不标prod/上线；未通过不标完成 |

## 待填写的验收登记格式

后续每项按 `功能ID / 状态 / 产品revision / 实际代码与API / 测试或浏览器证据 / issue与PR / 剩余风险` 记录。R0 中本表的存在只满足盘点条件，不能作为任何业务项已通过的证据。
