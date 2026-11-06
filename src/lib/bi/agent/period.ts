import type { BiAgentPageScope } from './contracts';

/** Same inclusive-day comparison as ledger/overview.py. UTC day arithmetic
 * avoids DST; dates before the ledger's year-1 boundary are unavailable. */
export function previousBiPeriod(page: Pick<BiAgentPageScope, 'start' | 'end'>) {
  if (!page.start || !page.end) return null;
  const start = Date.parse(`${page.start}T00:00:00Z`), end = Date.parse(`${page.end}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  const days = (end - start) / 86400000 + 1, prior = start - days * 86400000;
  if (prior < Date.parse('0001-01-01T00:00:00Z')) return null;
  return { start: new Date(prior).toISOString().slice(0, 10),
    end: new Date(start - 86400000).toISOString().slice(0, 10), days };
}
