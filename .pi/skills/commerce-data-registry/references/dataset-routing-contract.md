# 零售数据集路由合同

每次分析先确定 `dataset_id`，再选择最小的只读端点。路由脚本只根据已确认的输入做确定性选择。

| 任务 | 端点 | 必须保留 |
| --- | --- | --- |
| 数据集发现 | `/api/v1/commerce/datasets` | 数据集标识、名称、来源、可用状态 |
| 元数据 | `/api/v1/commerce/meta?dataset_id=...` | 窗口、行数、来源、合成字段、质量 |
| 经营分析 | `/api/v1/commerce/analytics/{kind}?dataset_id=...` | dataset_id、口径、行数、时间 |
| 商品明细 | `/api/v1/commerce/items/{item_id}/events?dataset_id=...` | 商品标识、事件数、窗口、缺口 |

禁止把一个数据集的结果用于另一个数据集，也禁止通过默认参数省略用户已选择的数据集。缺少商品明细时，聚合结果只能作为全局证据，不能回答具体商品排名。
