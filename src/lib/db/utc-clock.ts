import { Prisma } from '@prisma/client';

// Prisma DateTime values in these tables are UTC in PostgreSQL TIMESTAMP(3)
// columns. Compare like types so the connection's TimeZone cannot shift a lease.
export const utcDatabaseClock = Prisma.sql`(clock_timestamp() AT TIME ZONE 'UTC')`;

export const utcTransactionClock = Prisma.sql`(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')`;

// Raw Date parameters are sent as timestamptz; ORM filters handle this internally.
export function utcTimestamp(instant: Date) {
  return Prisma.sql`(${instant}::timestamptz AT TIME ZONE 'UTC')`;
}
