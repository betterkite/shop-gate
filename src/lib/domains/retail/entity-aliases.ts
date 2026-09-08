/**
 * 零售实体词表与显式引用形式。
 *
 * 与金融包的关键差异：零售实体 ID 是任意大整数，且类目/商品来自真实数据集，
 * 零售实体（商品/类目）不能像代码表那样在 TS 里维护“别名→代码”的静态映射。因此：
 * - 静态词表只存“关键词 → 搜索词 + 实体类型”，真正解析由运行时
 *   `/api/v1/commerce/resolve` 完成（数据驱动）；
 * - 显式形式固定为 `item:<id>` / `cat:<id>`；
 * - 裸数字不作为实体引用（避免把日期、金额误判成商品 ID）。
 */

export type RetailEntityKind = 'category' | 'item';

export interface KnownEntityAlias {
  keyword: string;
  kind: RetailEntityKind;
  /** 传给 /resolve 的搜索词。 */
  term: string;
  name: string;
}

export interface KnownEntityAliasMatch {
  alias: KnownEntityAlias;
  start: number;
  end: number;
}

const CATEGORY_ALIAS_WORDS: ReadonlyArray<[string, string]> = [
  ['家居', '家居'],
  ['数码', '数码'],
  ['服饰', '服饰'],
  ['美妆', '美妆'],
  ['食品', '食品'],
  ['运动', '运动'],
  ['母婴', '母婴'],
  ['图书', '图书'],
  ['家电', '家电'],
  ['百货', '百货'],
];

export const KNOWN_ENTITY_ALIASES: readonly KnownEntityAlias[] =
  CATEGORY_ALIAS_WORDS.map(([keyword, term]) => ({
    keyword,
    kind: 'category' as const,
    term,
    name: `${term}类目`,
  }));

const EXPLICIT_ENTITY_PATTERN = /\b(?:item|cat):(\d+)\b/g;

export function extractExplicitEntityRefs(
  input: string,
): Array<{ kind: RetailEntityKind; id: number }> {
  const refs: Array<{ kind: RetailEntityKind; id: number }> = [];
  for (const match of input.matchAll(EXPLICIT_ENTITY_PATTERN)) {
    const kind: RetailEntityKind = match[0].startsWith('item:') ? 'item' : 'category';
    refs.push({ kind, id: Number.parseInt(match[1], 10) });
  }
  return refs;
}

/**
 * 最长非重叠 span 匹配（与上游算法一致）：
 * 简单 includes 会让「类目GMV」同时命中「类目」前缀，先选最长 span 保证
 * 规划/取数/澄清各方看到同一个无歧义视图。
 */
export function matchKnownEntityAliases(
  input: string,
  aliases: readonly KnownEntityAlias[] = KNOWN_ENTITY_ALIASES,
): KnownEntityAliasMatch[] {
  const haystack = input.toLocaleLowerCase();
  const candidates: Array<KnownEntityAliasMatch & { aliasIndex: number }> = [];

  aliases.forEach((alias, aliasIndex) => {
    const needle = alias.keyword.toLocaleLowerCase();
    if (!needle) return;

    let start = haystack.indexOf(needle);
    while (start >= 0) {
      candidates.push({ alias, start, end: start + needle.length, aliasIndex });
      start = haystack.indexOf(needle, start + 1);
    }
  });

  candidates.sort((left, right) =>
    (right.end - right.start) - (left.end - left.start) ||
    left.start - right.start ||
    left.aliasIndex - right.aliasIndex
  );

  const selected: Array<KnownEntityAliasMatch & { aliasIndex: number }> = [];
  for (const candidate of candidates) {
    const overlaps = selected.some(
      (match) => candidate.start < match.end && candidate.end > match.start
    );
    if (!overlaps) selected.push(candidate);
  }

  return selected
    .sort((left, right) => left.start - right.start || left.aliasIndex - right.aliasIndex)
    .map(({ aliasIndex: _aliasIndex, ...match }) => match);
}

export interface RetailEntityMention {
  kind: RetailEntityKind | 'term';
  /** 显式 ID（item:/cat: 形式）或需要运行时解析的搜索词。 */
  value: string;
  name: string;
}

export function inferRetailEntityMentionsFromText(input: string): RetailEntityMention[] {
  const mentions: RetailEntityMention[] = extractExplicitEntityRefs(input).map((ref) => ({
    kind: ref.kind,
    value: `${ref.kind === 'item' ? 'item' : 'cat'}:${ref.id}`,
    name: `${ref.kind === 'item' ? '商品' : '类目'} ${ref.id}`,
  }));
  for (const match of matchKnownEntityAliases(input)) {
    mentions.push({
      kind: 'term',
      value: match.alias.term,
      name: match.alias.name,
    });
  }
  return mentions;
}

/** 去掉被更长候选包含的短片段（与上游 keepLongestDistinctTextCandidates 一致）。 */
export function keepLongestDistinctTextCandidates(candidates: readonly string[]): string[] {
  const unique = Array.from(new Set(candidates.map((candidate) => candidate.trim()).filter(Boolean)));
  return unique.filter((candidate, index) => {
    const normalized = candidate.toLocaleLowerCase();
    return !unique.some((other, otherIndex) =>
      otherIndex !== index &&
      other.length > candidate.length &&
      other.toLocaleLowerCase().includes(normalized)
    );
  });
}
