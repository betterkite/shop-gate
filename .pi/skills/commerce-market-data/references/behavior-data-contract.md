# 零售行为数据合同

行为事件至少包含 `dataset_id`、`item_id`、`event_type` 和 `occurred_at`。允许的 `event_type` 为 `view`、`favorite`、`cart`、`buy`。

行为漏斗使用同一数据集和同一窗口：曝光/浏览（PV）→收藏→加购→购买。事件量未满足通常顺序时必须保留告警，不能为了画图静默调整。

每份证据至少记录 `source`、`as_of`、`fetched_at`、`row_count`、`data_quality` 和缺失字段。窗口外数据不参与趋势；商品级问法必须使用商品级事件明细。
