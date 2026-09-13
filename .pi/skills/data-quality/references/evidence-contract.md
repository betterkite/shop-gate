# 零售数据来源与质量证据契约

## 不可伪造原则

- `fetched_at` 只记录真实读取时间，不能用当前时间补空值。
- `as_of` 是数据本身的统计日期或时间，不能用读取时间替代。
- `source`、endpoint 和产物路径必须来自真实响应或注册表。
- `row_count=0`、字段缺失和数据异常是质量事实，不能用示例数据修复。
- evidence 不得包含 token、Cookie、Authorization、密码、API key 或私人路径。

## sources.json

```json
{
  "schemaVersion": 1,
  "runId": "request-123",
  "created_at": "2026-09-13T02:00:00.000Z",
  "sources": [
    {
      "dataset": "behavior_events",
      "dataset_id": "retail-demo-v1",
      "source": "commerce-data",
      "endpoint": "GET /api/v1/commerce/analytics/overview?dataset_id=...",
      "artifact_path": "data_file/raw/behavior-events.json",
      "as_of": "2026-09-12",
      "fetched_at": "2026-09-13T02:00:00.000Z",
      "status": "success"
    }
  ]
}
```

来源列表必须非空，端点只保留不敏感的路径和必要参数。

## data_quality.json

```json
{
  "schemaVersion": 1,
  "runId": "request-123",
  "status": "warning",
  "created_at": "2026-09-13T02:00:00.000Z",
  "datasets": [
    {
      "dataset": "behavior_events",
      "dataset_id": "retail-demo-v1",
      "row_count": 1200,
      "source": "commerce-data",
      "fetched_at": "2026-09-13T02:00:00.000Z",
      "as_of": "2026-09-12",
      "missing_fields": [],
      "warnings": [],
      "status": "ok",
      "required": true
    }
  ],
  "checks": [],
  "warnings": [],
  "limitations": []
}
```

`ok` 表示核心数据可用，`warning` 表示带限制继续，`error` 表示不能依赖该数据生成结论。多个数据集取最严重状态。

## 检查边界

- 行为数据检查页面浏览、收藏、加购、购买、去重用户和订单字段。
- 商品数据检查价格、类目和实体 ID；库存数据检查库存快照和可售天数。
- 利润、留存、价格观察和实验结果必须检查样本量与观察窗口。
- 图片识别、经营接口和人工确认字段拆成不同 dataset/source。

脚本只接收已经读取和验证的数据集元数据，不联网、不生成时间戳、不写文件。发现敏感凭据必须拒绝生成证据。
