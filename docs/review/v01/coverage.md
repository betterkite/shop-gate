# v0.1 功能验收登记

[基准功能矩阵](feature-matrix.md)列出 125 项要求。下表把每项要求关联到实际实现和对应的测试、网页实测或发布门禁。测试名称可以在相应文件内搜索。金额均来自隔离练习数据。[核算样例](../../../README.md) [性能测量](evidence/performance-100k.json)

在候选版本 `8755ea3`，Chrome 实际登录后逐页打开八个经营模块，在同一数据集和日期范围核对列表、图表、退款明细及经营助手。390 像素宽度下八个入口均可使用，浏览期间模型提交次数为 0。独立对话、确认后新建演示并返回原数据集、历史会话按 20 条和 5 条翻页均已核对。历史记录排除了 3 条内部消息，授权账号下载的 CSV 含退款金额 17.60，普通成员访问同一文件时看到权限提示。此前版本 `83a092e` 的 RepoSteward 八项检查记录为 `verification:97c8440fede25333c4b6ca1b7942c618`。合并和标签检查以 GitHub 对应提交的实际结果为准。

## 经营总览（OV）

经营总览在手算集复核净销售164元、贡献121元。保存自然月目标后重启恢复。 [任务 #91](https://github.com/betterkite/shop-gate/issues/91)

| 编号 | 检查内容 | 实现入口 | 可复核的检查 |
| --- | --- | --- | --- |
| OV01 | 净销售额、已核算贡献利润、付款订单数、付款客单价、利润率、退款金额占比 | [OverviewDashboard.tsx](../../../src/app/bi/overview/OverviewDashboard.tsx) | [test_overview_manual121_one_transaction_no_model_and_recordless_days_are_not_zero](../../../services/commerce-data/tests/test_ledger_overview_postgres.py) |
| OV02 | 等长前期比较；零/负基数、历史不足不伪造增长率 | [overview.py](../../../services/commerce-data/src/shopgate_commerce_data/ledger/overview.py) | [test_comparable_previous_window_and_week_boundary_have_independent_amounts](../../../services/commerce-data/tests/test_ledger_overview_postgres.py) |
| OV03 | 按日/周销售与利润趋势；选择期间查看依据 | [OverviewTrend.tsx](../../../src/app/bi/overview/OverviewTrend.tsx) | [test_comparable_previous_window_and_week_boundary_have_independent_amounts](../../../services/commerce-data/tests/test_ledger_overview_postgres.py) |
| OV04 | 渠道贡献、收入/利润切换及占比 | [OverviewDashboard.tsx](../../../src/app/bi/overview/OverviewDashboard.tsx) | [test_all23_channels_and24_stores_including_unset_target_have_stable20_paging](../../../services/commerce-data/tests/test_ledger_overview_postgres.py) |
| OV05 | 经营关注、变化事实、来源明细及继续分析 | [QualityEvidence.tsx](../../../src/app/bi/overview/QualityEvidence.tsx) | [test_exact_quality_evidence_deduplicates_lines_and_paginates_every_refund](../../../services/commerce-data/tests/test_ledger_overview_postgres.py) |
| OV06 | 月度目标与完成度；独立自然月而非当前筛选期间 | [TargetEditor.tsx](../../../src/app/bi/overview/TargetEditor.tsx) | [test_month_targets_ignore_item_and_partial_dates_but_inherit_store_platform](../../../services/commerce-data/tests/test_ledger_overview_postgres.py) |
| OV07 | 数据截止时间、来源、未核算收入/订单与核算覆盖 | [evidence.py](../../../services/commerce-data/src/shopgate_commerce_data/ledger/evidence.py) | [test_unknown_cost_does_not_become_profit_or_healthy_diagnosis](../../../services/commerce-data/tests/test_ledger_overview_postgres.py) |

## 渠道对比（CH）

ce6e371 核对单平台净销售164元、物流费用10元，在原页面、CSV 与店铺入口一致。 [任务 #94](https://github.com/betterkite/shop-gate/issues/94)

| 编号 | 检查内容 | 实现入口 | 可复核的检查 |
| --- | --- | --- | --- |
| CH01 | 拼多多、Temu 半托管、1688 等平台模型；币种/市场/模式 | [demo.py](../../../services/commerce-data/src/shopgate_commerce_data/ledger/demo.py) | [test_default_is_complete_named_1000_specs_180_days_not_1000_products](../../../services/commerce-data/tests/test_ledger_demo.py) |
| CH02 | 各平台销售、利润、利润率、订单/客单价、费用和退款 | [query.py](../../../services/commerce-data/src/shopgate_commerce_data/ledger/query.py) | [test_platform_fee_categories_reconcile_with_negative_adjustments_and_unknown_fx](../../../services/commerce-data/tests/test_ledger_overview_postgres.py) |
| CH03 | 横向对比、收入与利润关联图 | [RankedOperations.tsx](../../../src/components/bi/RankedOperations.tsx) | [test_platform_fee_categories_reconcile_with_negative_adjustments_and_unknown_fx](../../../services/commerce-data/tests/test_ledger_overview_postgres.py) |
| CH04 | 渠道趋势及指标切换；点击期间与平台 | [ChannelTrends.tsx](../../../src/components/bi/ChannelTrends.tsx) | [test_channel_periods_use_the_same_ledger_for_each_platform_and_page](../../../services/commerce-data/tests/test_ledger_overview_postgres.py) |
| CH05 | 渠道商品成本与各项费用；保留负费用调整 | [RankedOperations.tsx](../../../src/components/bi/RankedOperations.tsx) | [test_platform_fee_categories_reconcile_with_negative_adjustments_and_unknown_fx](../../../services/commerce-data/tests/test_ledger_overview_postgres.py) |
| CH06 | 平台内店铺、商品、订单与费用详情 | [SourceRecords.tsx](../../../src/components/bi/SourceRecords.tsx) | [test_fee_source_drill_preserves_scope_amounts_and_unallocated_order_attribution](../../../services/commerce-data/tests/test_ledger_overview_postgres.py) |
| CH07 | 完整平台表格，搜索、排序、全量访问与导出 | [ranking-export.ts](../../../src/lib/bi/ranking-export.ts) | [test_all23_channels_and24_stores_including_unset_target_have_stable20_paging](../../../services/commerce-data/tests/test_ledger_overview_postgres.py) |

## 店铺分析（ST）

ce6e371 在店铺001复算净销售104元、直接物流费用4元。目标预览与取消在933c886复核。 [任务 #94](https://github.com/betterkite/shop-gate/issues/94)

| 编号 | 检查内容 | 实现入口 | 可复核的检查 |
| --- | --- | --- | --- |
| ST01 | 店铺经营排名图与全量排名表 | [RankedOperations.tsx](../../../src/components/bi/RankedOperations.tsx) | [test_all23_channels_and24_stores_including_unset_target_have_stable20_paging](../../../services/commerce-data/tests/test_ledger_overview_postgres.py) |
| ST02 | 销售、利润、利润率、订单、退款、前期比较 | [OverviewDashboard.tsx](../../../src/app/bi/overview/OverviewDashboard.tsx) | [test_comparable_previous_window_and_week_boundary_have_independent_amounts](../../../services/commerce-data/tests/test_ledger_overview_postgres.py) |
| ST03 | 月度目标查询、修改、进度及持久化 | [TargetEditor.tsx](../../../src/app/bi/overview/TargetEditor.tsx) | [test_simultaneous_target_confirmations_have_only_one_version_winner](../../../services/commerce-data/tests/test_ledger_overview_postgres.py) |
| ST04 | 店铺详情：KPI、日/周趋势、相关商品与平台信息 | [OverviewTrend.tsx](../../../src/app/bi/overview/OverviewTrend.tsx) | [test_month_targets_ignore_item_and_partial_dates_but_inherit_store_platform](../../../services/commerce-data/tests/test_ledger_overview_postgres.py) |
| ST05 | 完整订单明细、订单行、成本/退款/费用证据 | [SourceRecords.tsx](../../../src/components/bi/SourceRecords.tsx) | [test_full_postings_pagination_original_orders_and_date_basis](../../../services/commerce-data/tests/test_ledger_overview_postgres.py) |
| ST06 | 全量店铺费用及退款明细 | [SourceRecords.tsx](../../../src/components/bi/SourceRecords.tsx) | [test_fee_source_drill_preserves_scope_amounts_and_unallocated_order_attribution](../../../services/commerce-data/tests/test_ledger_overview_postgres.py) |
| ST07 | 平台约束店铺选择，搜索/排序/分页/关联导航 | [ReferencePicker.tsx](../../../src/app/bi/overview/ReferencePicker.tsx) | [test_directory_parent_restrictions_names_permissions_and_stale_scope](../../../services/commerce-data/tests/test_ledger_overview_postgres.py) |

## 商品分析（PD）

商品维护及使用固定样例和千规格集的逐项记录见功能对照表中的商品阶段验收。 [任务 #94](https://github.com/betterkite/shop-gate/issues/94)

| 编号 | 检查内容 | 实现入口 | 可复核的检查 |
| --- | --- | --- | --- |
| PD01 | 商品、标准规格（SKU）、平台商品三个粒度 | [RankedOperations.tsx](../../../src/components/bi/RankedOperations.tsx) | [test_paid_coverage_and_weighted_unit_measures_ignore_refund_cost_reversals](../../../services/commerce-data/tests/test_ledger_overview_postgres.py) |
| PD02 | 畅销、高贡献、负贡献、低利润率、高退款、待核算筛选 | [ProductPerformance.tsx](../../../src/components/bi/ProductPerformance.tsx) | [test_product_performance_filter_is_calculated_before_paging_and_keeps_judgment_period](../../../services/commerce-data/tests/test_ledger_overview_postgres.py) |
| PD03 | 热销摘要、销售与利润率分布，完整列表入口 | [ProductPerformance.tsx](../../../src/components/bi/ProductPerformance.tsx) | [test_incomplete_product_filter_uses_ledger_quality_even_if_revenue_is_known](../../../services/commerce-data/tests/test_ledger_overview_postgres.py) |
| PD04 | 覆盖平台/店铺数、标准销量、单位售价、历史加权单位成本 | [metrics.py](../../../services/commerce-data/src/shopgate_commerce_data/ledger/metrics.py) | [test_unit_measures_disclose_partial_historical_costs_and_incompatible_units](../../../services/commerce-data/tests/test_ledger_overview_postgres.py) |
| PD05 | 同款跨店铺/平台比较，关联订单、退款和费用 | [RankedOperations.tsx](../../../src/components/bi/RankedOperations.tsx) | [test_different_standard_units_do_not_produce_a_blended_price](../../../services/commerce-data/tests/test_ledger_overview_postgres.py) |
| PD06 | 标准规格与平台编码映射完整查询、状态与搜索 | [ProductMappings.tsx](../../../src/components/bi/ProductMappings.tsx) | [test_mapping_directory_date_boundary_no_sales_scope_and_full_paging](../../../services/commerce-data/tests/test_ledger_overview_postgres.py) |
| PD07 | 映射/单位换算维护预览、确认、版本及审计 | [MappingEditor.tsx](../../../src/components/bi/MappingEditor.tsx) | [test_mapping_interval_gap_prior_future_and_stale_preview](../../../services/commerce-data/tests/test_ledger_overview_postgres.py) |
| PD08 | 缺映射修复不隐式改历史；显式历史重算关联 | [mapping_changes.py](../../../services/commerce-data/src/shopgate_commerce_data/ledger/mapping_changes.py) | [test_mapping_version_replacement_preserves_original_payments_until_confirmed_recalc](../../../services/commerce-data/tests/test_ledger_overview_postgres.py) |
| PD09 | 各店铺当前继承成本、来源层级、历史版本与成本管理入口 | [ListingCosts.tsx](../../../src/components/bi/ListingCosts.tsx) | [test_store_cost_history_resolves_layers_at_business_day_end_and_paginates](../../../services/commerce-data/tests/test_ledger_overview_postgres.py) |
| PD10 | 全量商品列表默认20条，搜索/排序/分页/全量导出 | [ranking-export.ts](../../../src/lib/bi/ranking-export.ts) | [test_directory_includes_all_idle_products_skus_and_stores_and_literal_search](../../../services/commerce-data/tests/test_ledger_overview_postgres.py) |

## 利润与费用（PF）

1a6ad10 的七月手算样例核对净销售164元、成本33元、物流10元、贡献121元。 [任务 #96](https://github.com/betterkite/shop-gate/issues/96)

| 编号 | 检查内容 | 实现入口 | 可复核的检查 |
| --- | --- | --- | --- |
| PF01 | 收入→退款→成本→各费用→贡献利润完整形成图 | [ProfitStatement.tsx](../../../src/components/bi/ProfitStatement.tsx) | [test_profit_statement_reconciles_two_periods_credit_fees_and_scope](../../../services/commerce-data/tests/test_ledger_overview_postgres.py) |
| PF02 | 平台/包装/商家物流/广告费用独立查询及占比 | [profit.py](../../../services/commerce-data/src/shopgate_commerce_data/ledger/profit.py) | [test_platform_fee_categories_reconcile_with_negative_adjustments_and_unknown_fx](../../../services/commerce-data/tests/test_ledger_overview_postgres.py) |
| PF03 | 前后期间金额变化拆解与桥接图 | [ProfitStatement.tsx](../../../src/components/bi/ProfitStatement.tsx) | [test_profit_statement_reconciles_two_periods_credit_fees_and_scope](../../../services/commerce-data/tests/test_ledger_overview_postgres.py) |
| PF04 | 按平台/店铺/商品等分组利润表、完整明细 | [RankedOperations.tsx](../../../src/components/bi/RankedOperations.tsx) | [test_profit_statement_reconciles_two_periods_credit_fees_and_scope](../../../services/commerce-data/tests/test_ledger_overview_postgres.py) |
| PF05 | 费用来源、分摊依据、订单/商品关联及负调整 | [SourceRecords.tsx](../../../src/components/bi/SourceRecords.tsx) | [test_fee_source_drill_preserves_scope_amounts_and_unallocated_order_attribution](../../../services/commerce-data/tests/test_ledger_overview_postgres.py) |
| PF06 | 未分摊费用单列，整体/店铺承担但不伪归属SKU | [profit.py](../../../services/commerce-data/src/shopgate_commerce_data/ledger/profit.py) | [test_expense_evidence_never_assigns_full_source_amount_to_selected_product](../../../services/commerce-data/tests/test_ledger_overview_postgres.py) |
| PF07 | 已核算/待核算收入与费用、贡献利润覆盖范围 | [ProfitStatement.tsx](../../../src/components/bi/ProfitStatement.tsx) | [test_profit_statement_distinguishes_incomplete_and_known_components](../../../services/commerce-data/tests/test_ledger_overview_postgres.py) |

## 退款与售后（RF）

865415b 按付款和退款完成日分别核对三笔退款96元，追到原单并下载对应记录。 [任务 #97](https://github.com/betterkite/shop-gate/issues/97)

| 编号 | 检查内容 | 实现入口 | 可复核的检查 |
| --- | --- | --- | --- |
| RF01 | 付款订单归属与退款发生时间两种独立口径 | [RefundAnalysis.tsx](../../../src/components/bi/RefundAnalysis.tsx) | [test_refund_analysis_matches_filtered_postings_and_preserves_original_denominator](../../../services/commerce-data/tests/test_ledger_overview_postgres.py) |
| RF02 | 已完成退款金额、去重关联订单、合适分母的退款比例 | [query.py](../../../services/commerce-data/src/shopgate_commerce_data/ledger/query.py) | [test_zero_negative_unknown_denominators_not_fake_growth](../../../services/commerce-data/tests/test_ledger_accounting.py) |
| RF03 | 原因分布/类型图；点击筛选与撤销 | [RefundAnalysis.tsx](../../../src/components/bi/RefundAnalysis.tsx) | [test_refund_analysis_matches_filtered_postings_and_preserves_original_denominator](../../../services/commerce-data/tests/test_ledger_overview_postgres.py) |
| RF04 | 仅退款、退货退款、未发货取消及部分退款 | [accounting.py](../../../services/commerce-data/src/shopgate_commerce_data/ledger/accounting.py) | [test_multiple_partial_foreign_refunds_full_amount_and_cost_conserve_cents](../../../services/commerce-data/tests/test_ledger_accounting.py) |
| RF05 | 可回收数量与原成本快照冲回；费用不自动清零 | [accounting.py](../../../services/commerce-data/src/shopgate_commerce_data/ledger/accounting.py) | [test_refund_only_keeps_cost_and_return_recovers_original_snapshot](../../../services/commerce-data/tests/test_ledger_accounting.py) |
| RF06 | 完整退款表、原因/类型/搜索/排序/分页及导出 | [RefundAnalysis.tsx](../../../src/components/bi/RefundAnalysis.tsx) | [test_full_postings_pagination_original_orders_and_date_basis](../../../services/commerce-data/tests/test_ledger_overview_postgres.py) |
| RF07 | 退款事件→原订单→订单行/商品/店铺证据 | [SourceRecords.tsx](../../../src/components/bi/SourceRecords.tsx) | [test_full_postings_pagination_original_orders_and_date_basis](../../../services/commerce-data/tests/test_ledger_overview_postgres.py) |

## 报表中心（RP）

ebdb6a9 在浏览器按七种报表逐格对照 CSV，在另一样例导出了跨页的221行，并检查视图重启和权限冲突。 [任务 #99](https://github.com/betterkite/shop-gate/issues/99)

| 编号 | 检查内容 | 实现入口 | 可复核的检查 |
| --- | --- | --- | --- |
| RP01 | 日报、平台、店铺、商品、订单、退款、成本变更七类报表 | [reports.py](../../../services/commerce-data/src/shopgate_commerce_data/ledger/reports.py) | [test_report_csv_matches_full_scope_and_personal_view_revision](../../../services/commerce-data/tests/test_ledger_overview_postgres.py) |
| RP02 | 搜索、范围、全量分页、排序、显示列 | [ReportCenter.tsx](../../../src/components/bi/ReportCenter.tsx) | [test_report_csv_matches_full_scope_and_personal_view_revision](../../../services/commerce-data/tests/test_ledger_overview_postgres.py) |
| RP03 | 保存/恢复视图的报表类型、筛选、列和排序 | [ReportViews.tsx](../../../src/components/bi/ReportViews.tsx) | [test_report_csv_matches_full_scope_and_personal_view_revision](../../../services/commerce-data/tests/test_ledger_overview_postgres.py) |
| RP04 | 保存视图重命名、删除及权限冲突保护 | [report_views.py](../../../services/commerce-data/src/shopgate_commerce_data/ledger/report_views.py) | [test_report_csv_matches_full_scope_and_personal_view_revision](../../../services/commerce-data/tests/test_ledger_overview_postgres.py) |
| RP05 | 分析报表 CSV 全范围导出及公式注入保护 | [reports.py](../../../services/commerce-data/src/shopgate_commerce_data/ledger/reports.py) | [test_report_csv_matches_full_scope_and_personal_view_revision](../../../services/commerce-data/tests/test_ledger_overview_postgres.py) |
| RP06 | 当前成本与成本变更分别导出 | [CostDirectory.tsx](../../../src/components/bi/CostDirectory.tsx) | [test_directory_separates_active_cost_date_from_original_payments_and_keeps_missing_skus](../../../services/commerce-data/tests/test_ledger_overview_postgres.py) |
| RP07 | 标准数据导出可往返，与展示报表用途区分 | [exchange.py](../../../services/commerce-data/src/shopgate_commerce_data/ledger/exchange.py) | [test_all_twelve_exports_rehydrate_new_dataset_without_changing_fact_values](../../../services/commerce-data/tests/test_ledger_exchange_postgres.py) |
| RP08 | 导入中心：模板说明、多文件上传、预览、错误下载与确认 | [DataCenter.tsx](../../../src/app/bi/data/DataCenter.tsx) | [test_complete_preview_manual_money_confirmation_and_all_twelve_exports](../../../services/commerce-data/tests/test_ledger_jobs_postgres.py) |
| RP09 | 导入批次、文件摘要、模板/操作状态、批次错误详情 | [DataCenter.tsx](../../../src/app/bi/data/DataCenter.tsx) | [test_batch_history_full_paging_includes_direct_imports_and_off_page_details](../../../services/commerce-data/tests/test_ledger_exchange_postgres.py) |

## 商品成本（CT）

52d540d 核对成本试算、批调、确认和历史重算。包括独立读取成本规则和原付款快照。 [任务 #98](https://github.com/betterkite/shop-gate/issues/98)

| 编号 | 检查内容 | 实现入口 | 可复核的检查 |
| --- | --- | --- | --- |
| CT01 | 基础/平台/店铺规格成本、来源与继承明细 | [CostDirectory.tsx](../../../src/components/bi/CostDirectory.tsx) | [test_store_cost_history_resolves_layers_at_business_day_end_and_paginates](../../../services/commerce-data/tests/test_ledger_overview_postgres.py) |
| CT02 | 按生效日期查询；全量列表、搜索、排序、分页和批量选择 | [cost_directory.py](../../../services/commerce-data/src/shopgate_commerce_data/ledger/cost_directory.py) | [test_directory_separates_active_cost_date_from_original_payments_and_keeps_missing_skus](../../../services/commerce-data/tests/test_ledger_overview_postgres.py) |
| CT03 | 成本版本/生效区间/来源说明/变更与历史 | [cost_changes.py](../../../services/commerce-data/src/shopgate_commerce_data/ledger/cost_changes.py) | [test_batch_cost_preview_confirmation_and_separate_historical_recalculation](../../../services/commerce-data/tests/test_ledger_overview_postgres.py) |
| CT04 | 新增或调整单规格成本及层级作用范围 | [CostChangeForm.tsx](../../../src/components/bi/CostChangeForm.tsx) | [test_batch_cost_preview_confirmation_and_separate_historical_recalculation](../../../services/commerce-data/tests/test_ledger_overview_postgres.py) |
| CT05 | 批量固定值、金额增减、百分比增减 | [cost_changes.py](../../../services/commerce-data/src/shopgate_commerce_data/ledger/cost_changes.py) | [test_batch_cost_preview_confirmation_and_separate_historical_recalculation](../../../services/commerce-data/tests/test_ledger_overview_postgres.py) |
| CT06 | 影响预览：变更前后、涉及对象、覆盖/利润差异 | [CostMaintenance.tsx](../../../src/components/bi/CostMaintenance.tsx) | [test_batch_cost_preview_confirmation_and_separate_historical_recalculation](../../../services/commerce-data/tests/test_ledger_overview_postgres.py) |
| CT07 | 只读试算、标准单位及利润变化对照 | [CostSimulation.tsx](../../../src/components/bi/CostSimulation.tsx) | [test_read_only_cost_simulation_uses_standard_units_and_original_refund_recovery](../../../services/commerce-data/tests/test_ledger_overview_postgres.py) |
| CT08 | 缺成本/映射/汇率修复后的显式历史重算 | [recalculation.py](../../../services/commerce-data/src/shopgate_commerce_data/ledger/recalculation.py) | [test_current_cost_change_never_rewrites_historical_and_partial_recalc](../../../services/commerce-data/tests/test_ledger_accounting_postgres.py) |
| CT09 | 提交幂等、键冲突、预览过期、版本并发保护 | [operations.py](../../../services/commerce-data/src/shopgate_commerce_data/ledger/operations.py) | [test_concurrent_recalc_one_commit_idempotent_replay_and_history_protection](../../../services/commerce-data/tests/test_ledger_accounting_postgres.py) |
| CT10 | 操作记录、影响对象、操作者、来源和可核对审计 | [CostMaintenance.tsx](../../../src/components/bi/CostMaintenance.tsx) | [test_batch_cost_preview_confirmation_and_separate_historical_recalculation](../../../services/commerce-data/tests/test_ledger_overview_postgres.py) |

## 标准文件交换（IO）

十二类文件分别通过同一组往返断言。实际浏览器下载的十二份文件经解析与原始记录逐项相同。 [任务 #86](https://github.com/betterkite/shop-gate/issues/86)

| 编号 | 检查内容 | 实现入口 | 可复核的检查 |
| --- | --- | --- | --- |
| IO01 | channels：销售平台身份/名称 | [csv_contract.py](../../../services/commerce-data/src/shopgate_commerce_data/ledger/csv_contract.py) | [test_all_twelve_exports_rehydrate_new_dataset_without_changing_fact_values](../../../services/commerce-data/tests/test_ledger_exchange_postgres.py) |
| IO02 | stores：平台、市场、模式、原币、时区 | [csv_contract.py](../../../services/commerce-data/src/shopgate_commerce_data/ledger/csv_contract.py) | [test_all_twelve_exports_rehydrate_new_dataset_without_changing_fact_values](../../../services/commerce-data/tests/test_ledger_exchange_postgres.py) |
| IO03 | products：商品、类目、系列 | [csv_contract.py](../../../services/commerce-data/src/shopgate_commerce_data/ledger/csv_contract.py) | [test_all_twelve_exports_rehydrate_new_dataset_without_changing_fact_values](../../../services/commerce-data/tests/test_ledger_exchange_postgres.py) |
| IO04 | skus：标准规格、商品引用、单位 | [csv_contract.py](../../../services/commerce-data/src/shopgate_commerce_data/ledger/csv_contract.py) | [test_all_twelve_exports_rehydrate_new_dataset_without_changing_fact_values](../../../services/commerce-data/tests/test_ledger_exchange_postgres.py) |
| IO05 | mappings：店铺平台商品/规格、标准规格、倍数、状态 | [csv_contract.py](../../../services/commerce-data/src/shopgate_commerce_data/ledger/csv_contract.py) | [test_all_twelve_exports_rehydrate_new_dataset_without_changing_fact_values](../../../services/commerce-data/tests/test_ledger_exchange_postgres.py) |
| IO06 | fx_rates：原币、业务日期、汇率、来源 | [csv_contract.py](../../../services/commerce-data/src/shopgate_commerce_data/ledger/csv_contract.py) | [test_all_twelve_exports_rehydrate_new_dataset_without_changing_fact_values](../../../services/commerce-data/tests/test_ledger_exchange_postgres.py) |
| IO07 | costs：分层成本、生效区间、备注 | [csv_contract.py](../../../services/commerce-data/src/shopgate_commerce_data/ledger/csv_contract.py) | [test_all_twelve_exports_rehydrate_new_dataset_without_changing_fact_values](../../../services/commerce-data/tests/test_ledger_exchange_postgres.py) |
| IO08 | orders：平台订单/店铺、付款时间、状态、原币/汇率 | [csv_contract.py](../../../services/commerce-data/src/shopgate_commerce_data/ledger/csv_contract.py) | [test_all_twelve_exports_rehydrate_new_dataset_without_changing_fact_values](../../../services/commerce-data/tests/test_ledger_exchange_postgres.py) |
| IO09 | order_lines：订单/平台规格、数量/倍数、商品实收原币金额 | [csv_contract.py](../../../services/commerce-data/src/shopgate_commerce_data/ledger/csv_contract.py) | [test_all_twelve_exports_rehydrate_new_dataset_without_changing_fact_values](../../../services/commerce-data/tests/test_ledger_exchange_postgres.py) |
| IO10 | refunds：订单行、完成时间、金额、类型、原因、数量/可回收量 | [csv_contract.py](../../../services/commerce-data/src/shopgate_commerce_data/ledger/csv_contract.py) | [test_all_twelve_exports_rehydrate_new_dataset_without_changing_fact_values](../../../services/commerce-data/tests/test_ledger_exchange_postgres.py) |
| IO11 | expenses：店铺/日期/科目、正负原币金额、汇率、订单/行与来源 | [csv_contract.py](../../../services/commerce-data/src/shopgate_commerce_data/ledger/csv_contract.py) | [test_all_twelve_exports_rehydrate_new_dataset_without_changing_fact_values](../../../services/commerce-data/tests/test_ledger_exchange_postgres.py) |
| IO12 | targets：店铺、月份、目标金额 | [csv_contract.py](../../../services/commerce-data/src/shopgate_commerce_data/ledger/csv_contract.py) | [test_all_twelve_exports_rehydrate_new_dataset_without_changing_fact_values](../../../services/commerce-data/tests/test_ledger_exchange_postgres.py) |

## 公共交互（UX）

跨模块、权限、页面和账号使用不同浏览器会话复核。 [任务 #100](https://github.com/betterkite/shop-gate/issues/100)

| 编号 | 检查内容 | 实现入口 | 可复核的检查 |
| --- | --- | --- | --- |
| UX01 | 八个业务入口、统一导航，独立对话与受权限保护的管理入口 | [BusinessEntry.tsx](../../../src/components/bi/BusinessEntry.tsx) | 83a092e 八入口实际点击，独立对话另核对 |
| UX02 | 日期/平台/店铺/商品/类目/搜索/排序/页码进入URL与统一上下文 | [overview-contracts.ts](../../../src/lib/bi/overview-contracts.ts) | [test_directory_parent_restrictions_names_permissions_and_stale_scope](../../../services/commerce-data/tests/test_ledger_overview_postgres.py) |
| UX03 | 店铺受平台约束，图表联动可撤销、关联详情保留范围 | [ChannelTrends.tsx](../../../src/components/bi/ChannelTrends.tsx) | [test_channel_periods_use_the_same_ledger_for_each_platform_and_page](../../../services/commerce-data/tests/test_ledger_overview_postgres.py) |
| UX04 | 全量列表服务端分页默认20，过滤/排序先于分页，稳定排序 | [query.py](../../../services/commerce-data/src/shopgate_commerce_data/ledger/query.py) | [test_all23_channels_and24_stores_including_unset_target_have_stable20_paging](../../../services/commerce-data/tests/test_ledger_overview_postgres.py) |
| UX05 | 翻页/排序/详情不跳顶部；摘要有查看全部和范围说明 | [BiPrimitives.tsx](../../../src/components/bi/BiPrimitives.tsx) | 浏览器翻页与返回恢复 |
| UX06 | Shop Gate 青蓝/深浅色，先总览与商品详情视觉样板 | [BiPrimitives.tsx](../../../src/components/bi/BiPrimitives.tsx) | 深浅两主题与390像素宽度 |
| UX07 | 中文优先、缩写释义、诊断有事实/证据/下一步 | [BiAssistantEvidence.tsx](../../../src/components/bi/BiAssistantEvidence.tsx) | 核算缺项页与金额释义 |
| UX08 | 加载、错误、重试、无权限、空数据、真实零与未知区分 | [OverviewWorkspace.tsx](../../../src/app/bi/overview/OverviewWorkspace.tsx) | [test_unknown_cost_does_not_become_profit_or_healthy_diagnosis](../../../services/commerce-data/tests/test_ledger_overview_postgres.py) |
| UX09 | 十二类多文件依赖排序、预览不写入、整批事务回滚 | [exchange.py](../../../services/commerce-data/src/shopgate_commerce_data/ledger/exchange.py) | [test_accounting_failure_rolls_back_last_stage_and_can_retry_same_key](../../../services/commerce-data/tests/test_ledger_exchange_postgres.py) |
| UX10 | 同记录跳过、同键异内容冲突、请求幂等与版本不空增 | [exchange.py](../../../services/commerce-data/src/shopgate_commerce_data/ledger/exchange.py) | [test_parallel_same_key_commits_exactly_once](../../../services/commerce-data/tests/test_ledger_exchange_postgres.py) |
| UX11 | UTF-8/BOM/中文/引号/换行/前导零，有限十进制精度 | [csv_contract.py](../../../services/commerce-data/src/shopgate_commerce_data/ledger/csv_contract.py) | [test_text_roundtrip_preserves_bom_chinese_zero_formula_quotes_and_newlines](../../../services/commerce-data/tests/test_ledger_csv_contract.py) |
| UX12 | 上传文件/行数/耗时限额，规范化暂存、过期预览与安全清理 | [retention.py](../../../services/commerce-data/src/shopgate_commerce_data/ledger/retention.py) | [test_retention_changed_inventory_and_plan_expiration_roll_back_without_receipt](../../../services/commerce-data/tests/test_ledger_jobs_postgres.py) |
| UX13 | 导入成功版本递增、缓存失效、页面刷新、旧分析保留原版本 | [OverviewWorkspace.tsx](../../../src/app/bi/overview/OverviewWorkspace.tsx) | [test_concurrent_new_import_cannot_mix_overview_snapshot_or_cross_workspace](../../../services/commerce-data/tests/test_ledger_overview_postgres.py) |
| UX14 | 只读查看的报表导出与可重导入标准数据的安全策略分别定义 | [reports.py](../../../services/commerce-data/src/shopgate_commerce_data/ledger/reports.py) | [test_invalid_rows_errors_do_not_echo_private_cells_and_report_is_safe](../../../services/commerce-data/tests/test_ledger_csv_contract.py) |

## 经营账本（AC）

固定手算样例、独立 PostgreSQL 账本与可重建的十万订单集分别验收。 [任务 #85](https://github.com/betterkite/shop-gate/issues/85)

| 编号 | 检查内容 | 实现入口 | 可复核的检查 |
| --- | --- | --- | --- |
| AC01 | 订单/行、退款、成本版本/快照、费用/分摊、映射/汇率/目标账本 | [006-bi-ledger.sql](../../../sqls/ledger/006-bi-ledger.sql) | [test_migration_repeat_and_checksum_not_silent_mutation](../../../services/commerce-data/tests/test_ledger_postgres.py) |
| AC02 | 成交来自实收明细、订单去重、标准单位销量 | [accounting.py](../../../services/commerce-data/src/shopgate_commerce_data/ledger/accounting.py) | [test_payment_snapshot_unit_conversion_and_three_level_priority](../../../services/commerce-data/tests/test_ledger_accounting.py) |
| AC03 | 店铺>平台>基础并按付款时间匹配；不可变历史快照 | [accounting.py](../../../services/commerce-data/src/shopgate_commerce_data/ledger/accounting.py) | [test_half_open_intervals_future_cost_not_historical](../../../services/commerce-data/tests/test_ledger_accounting.py) |
| AC04 | 仅退款保留成本；可回收量按原快照冲回；累计约束 | [accounting.py](../../../services/commerce-data/src/shopgate_commerce_data/ledger/accounting.py) | [test_multiple_partial_foreign_refunds_full_amount_and_cost_conserve_cents](../../../services/commerce-data/tests/test_ledger_accounting.py) |
| AC05 | 完整源范围稳定分摊；精确余数；不能归属的费用单列 | [accounting.py](../../../services/commerce-data/src/shopgate_commerce_data/ledger/accounting.py) | [test_cent_allocation_exact_conservation_and_stable_ties](../../../services/commerce-data/tests/test_ledger_accounting.py) |
| AC06 | 缺成本/映射/汇率保留未知、已核算范围与覆盖率 | [recalculation.py](../../../services/commerce-data/src/shopgate_commerce_data/ledger/recalculation.py) | [test_missing_cost_repair_requires_confirmation_preserves_old_snapshot](../../../services/commerce-data/tests/test_ledger_accounting_postgres.py) |
| AC07 | 金额2位、成本/数量4位、汇率8位精确存储计算；API十进制字符串 | [precision.py](../../../services/commerce-data/src/shopgate_commerce_data/ledger/precision.py) | [test_precision_rejects_loss_nonfinite_and_overflow](../../../services/commerce-data/tests/test_ledger_precision_scope.py) |
| AC08 | 付款与退款时间口径、原币/折算及来源、汇总比率重算 | [metrics.py](../../../services/commerce-data/src/shopgate_commerce_data/ledger/metrics.py) | [test_different_standard_units_not_added_and_ratios_use_aggregate_numerators](../../../services/commerce-data/tests/test_ledger_accounting.py) |
| AC09 | 统一指标目录：中文名、来源/公式/单位、维度/分母/缺失处理 | [metrics.py](../../../services/commerce-data/src/shopgate_commerce_data/ledger/metrics.py) | [test_metric_catalog_and_version_scope_cache_are_complete](../../../services/commerce-data/tests/test_ledger_accounting.py) |
| AC10 | 最近区间取数据集最新业务日，随机种子与日期独立 | [demo.py](../../../services/commerce-data/src/shopgate_commerce_data/ledger/demo.py) | [test_seed_and_business_date_are_separate_inputs](../../../services/commerce-data/tests/test_ledger_demo.py) |
| AC11 | 工作空间/数据集/权限/版本贯穿查询、缓存、导出、Agent | [gateway-scope.ts](../../../src/lib/bi/gateway-scope.ts) | [test_version_cross_workspace_read_only_and_scope_cache](../../../services/commerce-data/tests/test_ledger_accounting_postgres.py) |
| AC12 | 约1000规格、180天、多平台店铺，热点/长尾/活动/费用退款/未知场景 | [demo.py](../../../services/commerce-data/src/shopgate_commerce_data/ledger/demo.py) | [test_nonflat_demand_long_tail_and_no_sales_expense](../../../services/commerce-data/tests/test_ledger_demo.py) |
| AC13 | 演示/正式隔离；初始化不重置；仅明确确认允许演示重置 | [DataCenter.tsx](../../../src/app/bi/data/DataCenter.tsx) | [test_demo_plan_is_confirmed_new_empty_demo_only_and_never_auto_commits](../../../services/commerce-data/tests/test_ledger_jobs_postgres.py) |
| AC14 | 迁移、备份、恢复、操作持久化，重启目标/映射/成本/视图仍在 | [migrations.py](../../../services/commerce-data/src/shopgate_commerce_data/ledger/migrations.py) | 恢复94张原表及15,265条付款快照 |
| AC15 | 请求ID、错误分类、readiness、审计、长操作状态与取消边界 | [jobs.py](../../../services/commerce-data/src/shopgate_commerce_data/ledger/jobs.py) | [test_failures_have_actionable_safe_category_and_logs_without_partial_records](../../../services/commerce-data/tests/test_ledger_jobs_postgres.py) |

## 经营助手（AG）

模型注册、运行、权限和受控查询位于 src/lib/bi/agent。下表区分真实凭据与脚本模型回放。 [任务 #100](https://github.com/betterkite/shop-gate/issues/100)

| 编号 | 检查内容 | 实现入口 | 可复核的检查 |
| --- | --- | --- | --- |
| AG01 | 八页嵌入经营分析助手，不默认生成整页看板/修改源码 | [BiAssistant.tsx](../../../src/components/bi/BiAssistant.tsx) | 八模块网页与每模块模型记录 |
| AG02 | 继承页面范围、选中对象、工作空间、数据集/版本 | [contracts.ts](../../../src/lib/bi/agent/contracts.ts) | A07、A09、A27 |
| AG03 | 分析步骤、受控指标/维度/过滤工具，模型不能直接执行任意SQL | [tools.ts](../../../src/lib/bi/agent/tools.ts) | 受控工具及运行权限集成测试 |
| AG04 | 事实答案+来源，排名全量表格，趋势/比较相关图表 | [BiAssistantChart.tsx](../../../src/components/bi/BiAssistantChart.tsx) | A01、A06、A10、A13 |
| AG05 | 数据足够但展示不支持时继续问答/表格，不截断或跳页 | [BiAssistant.tsx](../../../src/components/bi/BiAssistant.tsx) | A03、A08 |
| AG06 | 必要且最少澄清；默认当前范围可见，不要求内部ID | [provenance.ts](../../../src/lib/bi/agent/provenance.ts) | A01、A09 完整问题直接返回依据 |
| AG07 | 多轮“为什么下降/继续看这些商品”、比较与证据继承 | [execution.ts](../../../src/lib/bi/agent/execution.ts) | A07、A20、A26 |
| AG08 | 明确持续查看时保存结构化专题分析，统一主题渲染 | [ReportBookmark.tsx](../../../src/components/bi/ReportBookmark.tsx) | A26–A28 历史专题证据 |
| AG09 | 成本/映射/目标/导入/重算：预览→明确确认→受控提交 | [CostChangeForm.tsx](../../../src/components/bi/CostChangeForm.tsx) | A11、A12、A16、A31、A32 |
| AG10 | 模型接入、会话、审批、取消、预算、执行记录承接验收 | [execution.ts](../../../src/lib/bi/agent/execution.ts) | 运行、取消、额度及重试集成测试 |
| AG11 | 模型不可用时基础BI正常；助手明确局部不可用 | [BiAssistant.tsx](../../../src/components/bi/BiAssistant.tsx) | A04 关闭模型仍读取121元经营贡献 |
| AG12 | ≥32固定场景，八模块每模块至少1例真实授权模型链路 | [execution.integration.test.ts](../../../src/lib/bi/agent/execution.integration.test.ts) | 见下表 A01–A32 |

## 发布与恢复（DL）

远端检查随本次发布执行。主分支合并与标签发布的权威状态以 GitHub 为准。 [任务 #100](https://github.com/betterkite/shop-gate/issues/100)

| 编号 | 检查内容 | 实现入口 | 可复核的检查 |
| --- | --- | --- | --- |
| DL01 | 产品/工作台Git边界、正确RepoSteward连接、任务证据和独立PR | 本机 RepoSteward 关联配置和[公开任务 #100](https://github.com/betterkite/shop-gate/issues/100) | #100 工作台登记与完整隔离验证 |
| DL02 | 旧商品运营/情报/分析链接迁移与历史会话/成果只读路径 | [HistoryArchive.tsx](../../../src/app/history/HistoryArchive.tsx) | 历史对话分20和5条两页，权限区分及下载 |
| DL03 | 旧模板/金融残留/无用资源有引用检查和可恢复清退记录 | [HistoryArchive.tsx](../../../src/app/history/HistoryArchive.tsx) | 29571a0 清理旧生成入口并保留只读路由 |
| DL04 | 正式PG多客户端事务、权限、并发、持久化/恢复验收 | [operations.py](../../../services/commerce-data/src/shopgate_commerce_data/ledger/operations.py) | [test_parallel_same_key_commits_exactly_once](../../../services/commerce-data/tests/test_ledger_exchange_postgres.py) |
| DL05 | 1000规格/100000订单，普通查询p95≤3秒 | [read_index.py](../../../services/commerce-data/src/shopgate_commerce_data/ledger/read_index.py) | 10万订单，每类24次，再测长任务并发 |
| DL06 | 单元、后端、类型、lint、构建、文档、必要E2E及CI通过 | [quality.yml](../../../.github/workflows/quality.yml) | 发布前核验本地完整检查及远端CI |
| DL07 | 安装/配置/模板/演示/迁移/备份恢复/部署完整交付 | [backup-recovery.md](../../../docs/review/v01/backup-recovery.md) | 实际恢复与七批标准数据生成 |
| DL08 | 全项实现验收、阻断/高严重度问题清零，按授权合并后验收 | [release-evidence.yml](../../../.github/workflows/release-evidence.yml) | 最终合并与标签检查 |

## 经营助手固定用例

真实模型使用已授权的 DeepSeek。回放用固定输入验证正式引擎、工具、分页和结果存储；模型断开和界面切换用例无需网络模型。可按用例比较[验收记录摘要](evidence/agent-cases.json)。

| 用例 | 方式 | 复核结果 |
| --- | --- | --- |
| A01 | DeepSeek | 164 元净销售、121 元经营贡献，读取原始账本并引用来源。 |
| A02 | 受控模型回放 | 本期 25 元、上期 30 元。查询两次并核对少 5 元的金额和前期日期。 |
| A03 | 受控模型回放 | 只问净销售额，回答附原始依据，返回的图表列表为空。 |
| A04 | 模型断开实测 | 关闭助手执行服务仍可读到已核算经营贡献 121 元，助手显示不可用。 |
| A05 | DeepSeek | 按当前平台分别查询并比较贡献；当前样例的拼多多为 121 元。 |
| A06 | 受控模型回放 | 按已选平台查询每日金额，折线图关联全部 25 个日期点。 |
| A07 | 受控模型回放 | 接续相同会话查询该平台的店铺；底层请求保留原平台。 |
| A08 | 受控模型回放 | 没有地理字段时返回可分页的店铺表，依据保留全部 25 项。 |
| A09 | DeepSeek | 店铺 001 在指定期间净销售 104 元、已核算经营贡献 72 元。 |
| A10 | 受控模型回放 | 25 家店铺的排名可看第二页，末行净销售 1 元，合计 325 元。 |
| A11 | DeepSeek 与网页 | 草案只调整净销售额目标，预览前后经营贡献目标相同。 |
| A12 | 浏览器与数据库 | 明确确认后目标才写入。检查版本竞争和只读角色，并在重启后读取原目标。 |
| A13 | DeepSeek 与网页 | 可分页看全部有经营记录的分组，1000 项标准规格目录另核对到第 50 页。 |
| A14 | DeepSeek 与网页 | 同款在跨店铺、跨平台查询和导出中的标准销量与历史单位成本逐项核对。 |
| A15 | DeepSeek | 对缺少成本的原付款明细给出缺项说明及有依据的金额。 |
| A16 | DeepSeek 与网页 | 真实换算草案转预览，再明确确认；原订单保留付款时的换算规则。 |
| A17 | DeepSeek | 利润形成金额相加为 121 元，与利润页一致。 |
| A18 | DeepSeek | 按成交、退款、成本和费用拆解两个期间，净变化为负 121 元。 |
| A19 | DeepSeek | 识别平台尚未分摊的费用 6 元，仍计入平台经营贡献。 |
| A20 | DeepSeek | 多轮查询保持数据版本 2，平台依据可回到付款订单与贡献。 |
| A21 | DeepSeek 与网页 | 分别按原付款日期和退款完成日期查询。 |
| A22 | DeepSeek | 仅退款保留原成本，可回收退货按原付款成本冲回。 |
| A23 | DeepSeek 与网页 | 从部分退款核对原始订单和冲回的成本。 |
| A24 | DeepSeek | 退款发生口径缺少对应付款分母，回答保留金额并说明原因。 |
| A25 | DeepSeek | 逐页查全 22 笔退款，人民币合计 17.60 元，专题数保持为零。 |
| A26 | DeepSeek 与网页 | 接着提问复核 17.60 元，点击确认后才保存回答专题。 |
| A27 | 浏览器 | 切换数据集后清空原会话、专题及 URL 中的原范围，没有新模型请求。 |
| A28 | 浏览器与数据库 | 导入后数据为版本 3、23 笔，原专题仍标记版本 2 并显示 17.60 元。 |
| A29 | DeepSeek | 解析指定日期与店铺的成本优先级，并保留单位与币种。 |
| A30 | DeepSeek 与网页 | 按假设单位成本试算，原账本金额和数据版本保持不变。 |
| A31 | DeepSeek 与数据库 | 过期确认请求返回 409，另核对重复确认及冲突。 |
| A32 | DeepSeek 与网页 | 显式查看重算草案，核对原付款范围后确认。 |
