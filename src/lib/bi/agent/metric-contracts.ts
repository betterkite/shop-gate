import { z } from 'zod';

/** Public business definitions only; no provider instructions or credentials. */
export const metricDefinitionSchema = z.object({
  id: z.string().min(1).max(80), name: z.string().min(1).max(200), unit: z.string().max(80),
  formula: z.string().min(1).max(2000), missing_policy: z.string().max(2000),
  dimensions: z.array(z.string().max(80)).max(40), source: z.string().max(2000), aggregation: z.string().max(2000),
}).strict();
export const metricCatalogSchema = z.array(metricDefinitionSchema).max(100)
  .refine((rows) => new Set(rows.map((row) => row.id)).size === rows.length);
export const definitionEvidenceSchema = z.object({ source_id: z.string().uuid(),
  digest: z.string().regex(/^[0-9a-f]{64}$/), recorded_at: z.string().datetime(),
  metrics: metricCatalogSchema });
