# 经营图片证据契约

## 证据层级

严格区分：

1. 图片元数据：路径、文件名、格式、尺寸、字节数和 SHA-256。
2. 视觉识别值：识别工具实际看到的文字、日期和数字。
3. 数据接口补全值：商品解析或经营数据接口返回的字段。

接口补全值不能写成“截图中的值”，模型推断也不能写成用户提供的事实。

## 图片元数据

```json
{
  "path": "uploads/catalog.png",
  "name": "catalog.png",
  "mimeType": "image/png",
  "width": 1170,
  "height": 2532,
  "sha256": "64-character-hex-digest"
}
```

哈希绑定原始附件；图片变更后必须重新计算。

## 结构化字段

```json
{
  "item": {
    "item_id": null,
    "sku": null,
    "name": null,
    "category": null,
    "price": null,
    "inventory": null
  },
  "metrics": {
    "pv": null,
    "uv": null,
    "favorite": null,
    "cart": null,
    "buy": null,
    "order_count": null,
    "gmv": null
  },
  "report_date": null
}
```

无法可靠读取的字段写 `null`，并加入 `manual_confirmation_fields`。截图没有单位时保留原文或置空，不自行假设元、件或百分比单位。

## 证据落盘

`evidence/image_extraction.json` 至少记录图片数量和哈希、识别方式、识别时间（真实存在时）、已识别字段、待确认字段、接口补全字段及限制。不得写入 Token、Cookie、Authorization、密码或 API key。
