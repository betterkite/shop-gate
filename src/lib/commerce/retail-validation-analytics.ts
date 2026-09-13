type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

export function hasAnyKeyDeep(value: unknown, keys: string[]): boolean {
  if (Array.isArray(value)) return value.some((entry) => hasAnyKeyDeep(entry, keys));
  const record = asRecord(value);
  return Boolean(record && Object.entries(record).some(([key, nestedValue]) =>
    keys.includes(key) || hasAnyKeyDeep(nestedValue, keys)));
}

export function hasRetailPlaceholderSmell(parsed: unknown, serialized: string): boolean {
  const hasSyntheticProjectionDisclosure =
    hasAnyKeyDeep(parsed, ['synthetic_fields']) &&
    (hasAnyKeyDeep(parsed, ['limitations']) || hasAnyKeyDeep(parsed, ['scope']));
  return /mock|example|placeholder|lorem|示例|样例|假数据/i.test(serialized) ||
    (/模拟/i.test(serialized) && !hasSyntheticProjectionDisclosure);
}

export function missingAnalyticsBiDataFields(value: JsonRecord | null): string[] {
  const datasets = asRecord(value?.datasets);
  return [
    asRecord(datasets?.analyticsOverview) ? null : 'datasets.analyticsOverview',
    Array.isArray(asRecord(datasets?.analyticsLifecycle)?.items) ? null : 'datasets.analyticsLifecycle.items',
    asRecord(datasets?.analyticsRetention) ? null : 'datasets.analyticsRetention',
    asRecord(datasets?.analyticsProfit) ? null : 'datasets.analyticsProfit',
    Array.isArray(asRecord(datasets?.analyticsInventory)?.items) ? null : 'datasets.analyticsInventory.items',
    Array.isArray(asRecord(datasets?.analyticsReplenishment)?.items) ? null : 'datasets.analyticsReplenishment.items',
    Array.isArray(asRecord(datasets?.analyticsChannels)?.metrics) ? null : 'datasets.analyticsChannels.metrics',
  ].filter((item): item is string => Boolean(item));
}
