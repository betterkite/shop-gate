import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { operatingMethods, searchOperatingMethods } from '../../src/lib/bi/agent/operating-methods';

const server = new McpServer({ name: 'shop-gate-operating-methods', version: operatingMethods[0].version });

for (const method of operatingMethods) {
  server.registerResource(method.module, method.uri, { title: method.title, mimeType: 'application/json' },
    async () => ({ contents: [{ uri: method.uri, mimeType: 'application/json', text: JSON.stringify(method) }] }));
}

server.registerTool('search_operating_methods', {
  title: '查找经营口径',
  description: '按中文问题或 GMV 缩写查找公开的经营方法。用返回的资源地址读取说明。查询店铺实绩请使用已登录的经营页面。',
  inputSchema: { query: z.string().trim().min(1).max(500) },
  annotations: { readOnlyHint: true, openWorldHint: false },
}, async ({ query }) => {
  const matches = searchOperatingMethods(query).map(({ uri, title }) => ({ uri, title }));
  return { content: [{ type: 'text', text: JSON.stringify(matches) }], structuredContent: { matches } };
});

server.connect(new StdioServerTransport()).catch(() => {
  process.stderr.write('经营口径 MCP 启动失败。\n');
  process.exitCode = 1;
});
