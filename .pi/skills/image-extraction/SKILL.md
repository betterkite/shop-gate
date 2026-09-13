---
name: image-extraction
description: Normalize uploaded retail screenshots and catalog images into auditable product, inventory, order, and metric fields without inventing values.
---

# Shop Gate 图片提取能力

本 Skill 处理用户上传的商品、库存、订单、经营后台或数据报表截图。确定性工具只负责校验文件、格式、尺寸、哈希和字段结构；没有可信视觉识别结果时，不把推测写成事实。

## 资源与脚本

图片任务读取[经营图片证据契约](references/catalog-image-contract.md)，然后运行：

```bash
python .pi/skills/image-extraction/scripts/normalize_extraction.py \
  --input extraction-input.json
```

脚本只向标准输出返回归一化 JSON，不联网、不写项目文件、不执行识别。无法可靠解析的值写为 `null`，并放入人工确认列表。

## 触发条件

- 用户上传图片或表格截图。
- 当前任务存在 `.data-agent/attachments.json`。
- 用户询问截图中的商品、SKU、价格、库存、浏览量、购买量、订单或经营指标。

## 流程

1. 读取附件清单，确认路径、文件名、公开性、格式、尺寸和哈希。
2. 调用当前零售 Domain Pack 注册的 `commerce_extract_uploaded_image`，获取真实元数据和可验证字段。
3. 遇到 `manual_confirmation_required` 时保留空值并明确列出待确认字段。
4. 只对可信上游给出的字段运行归一化，结果写入 `evidence/image_extraction.json`。
5. 在最终数据中保留 `imageExtraction`，并把截图字段与数据接口补全字段分开。

## 字段边界

优先抽取商品名称、SKU、类目、价格、库存、页面浏览量（PV）、独立访客数（UV）、收藏、加购、购买、订单量、成交总额（GMV）和报表日期。截图没有出现的字段必须为 `null`，不能用数据集平均值填补。

如果截图中的实体需要标准化，交给 `commerce-entity-resolver`；如果需要窗口数据，交给 `commerce-market-data`；数据时效和缺失由 `data-quality` 记录。

## 禁止事项

- 不把截图外的信息当作截图事实。
- 不把接口价格覆盖截图价格。
- 不把识别失败伪装成成功。
- 不在 evidence、最终数据或页面中写入密钥、Cookie、授权值或私人路径。
