import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BiAnswerMarkdown } from './BiAnswerMarkdown';
describe('BI answer presentation', () => {
  it('renders semantic headings and tables without executing model HTML or loading remote content', () => {
    const html = renderToStaticMarkup(<BiAnswerMarkdown text={'## 核算结果\n\n**净销售额**\n\n| 项目 | 金额 |\n|---|---|\n| 净销售额 | 164.00 |\n\n<script>alert(1)</script>\n![tracking](https://example.invalid/a.png)'} />);
    expect(html).toContain('<table'); expect(html).toContain('<h3'); expect(html).toContain('<strong');
    expect(html).toContain('164.00'); expect(html).not.toContain('<script>'); expect(html).not.toContain('<img');
    expect(html).toContain('text-foreground');
  });
});
