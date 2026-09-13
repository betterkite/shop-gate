import { describe, expect, it } from 'vitest';

import {
  extractExplicitEntityRefs,
  inferRetailEntityMentionsFromText,
  keepLongestDistinctTextCandidates,
  matchKnownEntityAliases,
} from './entity-aliases';

describe('retail entity aliases', () => {
  it('extracts explicit item:/cat: refs only', () => {
    expect(extractExplicitEntityRefs('看下 item:1000329 和 cat:10051 的表现')).toEqual([
      { kind: 'item', id: 1000329 },
      { kind: 'category', id: 10051 },
    ]);
    // 裸数字不是实体引用（可能是日期/金额）
    expect(extractExplicitEntityRefs('GMV 442602.74，环比 5.86%')).toEqual([]);
  });

  it('matches category word aliases with longest-span semantics', () => {
    const matches = matchKnownEntityAliases('数码类目的转化率');
    expect(matches).toHaveLength(1);
    expect(matches[0].alias.term).toBe('数码');
    expect(matches[0].alias.kind).toBe('category');
  });

  it('infers mentions from text combining refs and aliases', () => {
    const mentions = inferRetailEntityMentionsFromText('对比家居类目和 item:1000329');
    const itemMention = mentions.find((mention) => mention.kind === 'item');
    const termMention = mentions.find((mention) => mention.kind === 'term');
    expect(itemMention?.value).toBe('item:1000329');
    // 别名只产出待运行时解析的搜索词（/resolve），不臆造实体 ID
    expect(termMention?.value).toBe('家居');
  });

  it('keeps longest distinct candidates', () => {
    expect(keepLongestDistinctTextCandidates(['数码', '数码类目', ''])).toEqual([
      '数码类目',
    ]);
  });
});
