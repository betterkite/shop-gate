import { describe, expect, it } from 'vitest';

import {
  ChatActContractError,
  MAX_CHAT_ACT_IMAGE_ATTACHMENTS,
  parseChatActRequest,
} from './chat-act-contract';

describe('chat act request contract', () => {
  it('accepts the single current camelCase contract', () => {
    expect(parseChatActRequest({
      instruction: '分析轻薄羽绒服',
      displayInstruction: '分析轻薄羽绒服',
      requestId: 'request-1',
      selectedModel: 'local_qwen:qwen3.5-9b-q5km',
      images: [{ name: 'holding.png', path: 'assets/holding.png', mimeType: 'image/png' }],
      isInitialPrompt: true,
      capabilityId: 'price_inventory',
      capabilitySelectionSource: 'manual',
      datasetId: 'retail-demo-p31',
      outputMode: 'act',
    })).toMatchObject({
      requestId: 'request-1',
      capabilityId: 'price_inventory',
      capabilitySelectionSource: 'manual',
      datasetId: 'retail-demo-p31',
      outputMode: 'act',
      images: [{ path: 'assets/holding.png' }],
      isInitialPrompt: true,
    });
  });

  it('supports an image-only request after the upload step', () => {
    const parsed = parseChatActRequest({ images: [{ path: 'assets/catalog.png' }] });
    expect(parsed.instruction).toBe('');
    expect(parsed.images).toHaveLength(1);
  });

  it.each([
    { instruction: 'x', request_id: 'old' },
    { instruction: 'x', selected_model: 'old' },
    { instruction: 'x', cliPreference: 'pi' },
    { instruction: 'x', commerceCapabilityId: 'old' },
    { instruction: 'x', commerceCapabilitySource: 'manual' },
    { instruction: 'x', images: [{ path: '/tmp/catalog.png' }] },
    { instruction: 'x', images: [{ path: 'assets/../catalog.png' }] },
    { instruction: 'x', images: [{ path: 'assets/catalog.png', base64_data: 'abc' }] },
  ])('rejects obsolete or unsafe input %#', (input) => {
    expect(() => parseChatActRequest(input)).toThrow(ChatActContractError);
  });

  it('bounds attachment fan-out', () => {
    expect(() => parseChatActRequest({
      images: Array.from(
        { length: MAX_CHAT_ACT_IMAGE_ATTACHMENTS + 1 },
        (_, index) => ({ path: `assets/${index}.png` }),
      ),
    })).toThrow(ChatActContractError);
  });
});
