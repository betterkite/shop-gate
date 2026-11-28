import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { describe, expect, it } from 'vitest';
import { operatingMethod, operatingMethodPrompt, operatingMethods, searchOperatingMethods } from './operating-methods';

describe('published operating methods', () => {
  it.each([
    ['最近的成交总额（ｇｍｖ）怎么算？', 'overview'],
    ['为什么这两个渠道的经营表现不同？', 'channels'],
    ['这个月的店铺目标完成了吗？', 'stores'],
    ['平台货号如何换成标准规格？', 'products'],
    ['为什么筛选商品后广告费还有这么多？', 'profit'],
    ['只退款也能冲回成本吗？', 'refunds'],
    ['导出的行数为何比屏幕上多？', 'reports'],
    ['调整成本后历史重算会改变什么？', 'costs'],
  ])('finds the relevant source for %s', (question, module) => {
    expect(searchOperatingMethods(question)[0]?.uri.split('/').at(-1)).toBe(module);
  });

  it('keeps unrelated questions empty and scopes the skill text to the active page', () => {
    expect(searchOperatingMethods('帮我拍一张图片')).toEqual([]);
    const prompt = operatingMethodPrompt('refunds');
    expect(prompt).toContain(operatingMethod('refunds').guidance);
    expect(prompt).not.toContain(operatingMethod('costs').guidance);
  });

  it('discovers, searches and reads the same versioned sources over standard I/O', async () => {
    const client = new Client({ name: 'shopgate-method-check', version: '1' });
    try {
      await client.connect(new StdioClientTransport({
        command: process.execPath, args: ['--import', 'tsx', 'scripts/mcp/operating-methods.ts'],
        cwd: process.cwd(), env: {},
      }));
      const { tools } = await client.listTools();
      expect(tools.map(tool => tool.name)).toEqual(['search_operating_methods']);
      expect(tools[0].annotations?.readOnlyHint).toBe(true);
      const { resources } = await client.listResources();
      expect(resources.map(r => r.uri).sort()).toEqual(operatingMethods.map(m => m.uri).sort());
      const found = await client.callTool({ name: tools[0].name, arguments: { query: '按原付款日看退款' } });
      const method = operatingMethod('refunds');
      expect(found.structuredContent).toMatchObject({ matches: expect.arrayContaining([{ uri: method.uri, title: method.title }]) });
      for (const item of operatingMethods) {
        const { contents } = await client.readResource({ uri: item.uri });
        expect(contents).toEqual([{ uri: item.uri, mimeType: 'application/json', text: JSON.stringify(item) }]);
      }
      await expect(client.readResource({ uri: 'shopgate://methods/unregistered' })).rejects.toThrow();
    } finally {
      await client.close();
    }
  }, 30_000);
});
