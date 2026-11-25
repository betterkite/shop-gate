import { z } from 'zod';

export const entityFields = {
  channel: 'channel_ids', store: 'store_ids', product: 'product_ids', sku: 'sku_ids', listing: 'listing_ids',
} as const;
export function isEntityDimension(value: string): value is keyof typeof entityFields {
  return Object.hasOwn(entityFields, value);
}

// Positions refer to rows in one immutable, private result, independent of the viewed page.
export const selectionSchema = z.object({
  result_id: z.string().uuid(),
  positions: z.array(z.number().int().min(1).max(10_000_000)).min(1).max(100)
    .refine((rows) => new Set(rows).size === rows.length)
    .transform((rows) => [...rows].sort((a, b) => a - b)),
}).strict();
export type EvidenceSelection = z.infer<typeof selectionSchema>;
export const savedSelectionSchema = selectionSchema.extend({
  dimension: z.enum(['channel', 'store', 'product', 'sku', 'listing']),
  entities: z.array(z.object({ key: z.string(), name: z.string() })).min(1).max(100),
});
