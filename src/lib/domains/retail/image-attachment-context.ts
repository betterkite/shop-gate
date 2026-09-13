import {
  DATA_AGENT_ATTACHMENTS_RELATIVE_PATH,
  type ProcessedDataAgentImageAttachment,
  writeDataAgentAttachmentManifest,
} from '@/lib/data-agent';

export async function writeRetailAttachmentContext(params: {
  projectRoot: string;
  projectId: string;
  requestId: string;
  images: ProcessedDataAgentImageAttachment[];
}): Promise<string | null> {
  return writeDataAgentAttachmentManifest({
    ...params,
    instruction:
      '这些图片由用户随本次问题上传。Agent 必须先读取本文件并检查图片，再解析其中的商品、库存、价格、销量、类目等字段。',
    extension: {
      extractionContract: {
        requiredSkill: 'image-extraction',
        requiredTool: 'commerce_extract_uploaded_image',
        productScreenshotFields: [
          'items[].name_or_title',
          'items[].item_id_if_visible',
          'items[].category_if_visible',
          'items[].price',
          'items[].stock',
          'items[].daily_sales',
          'summary.total_gmv_if_visible',
          'summary.total_orders_if_visible',
          'window_note',
        ],
        rule: '无法确定的截图字段必须写 null，并在 evidence/data_quality.json 说明不确定性，不允许编造。',
      },
    },
  });
}

export function buildRetailAttachmentInstruction(params: {
  attachmentContextPath: string | null;
  images: ProcessedDataAgentImageAttachment[];
}): string {
  if (params.images.length === 0) return '';

  const imageList = params.images
    .map((image, index) => `${index + 1}. ${image.name}：${image.path}`)
    .join('\n');
  return `
用户为本次任务上传了 ${params.images.length} 张图片。
- 附件清单：${params.attachmentContextPath ?? DATA_AGENT_ATTACHMENTS_RELATIVE_PATH}
- 必须先调用 commerce_extract_uploaded_image 读取每张图片，再结合零售数据接口生成结果。
- 当前不接入额外视觉模型或第三方 OCR；无法可靠识别的截图字段必须写 null，并在证据文件中列出需要用户确认的内容。
- 对识别出的类目/商品名称必须使用 /api/v1/commerce/resolve 解析实体，再获取真实行为流、库存与日报数据。
- 必须把图片提取结果写入 evidence/image_extraction.json；没有 OCR/视觉结果时也要写明 visualRecognition.status 和 needs_manual_confirmation。
- 最终 dashboard-data.json 必须保留 window、plannedEntities、datasets 和 imageExtraction 字段；imageExtraction 要说明哪些字段来自截图识别、哪些来自数据接口补全。
- 如果当前运行时无法直接识别图片视觉内容，也必须基于附件清单和文件路径继续处理，并明确列出需要人工确认的截图字段。

图片路径：
${imageList}`;
}
