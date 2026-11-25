/**
 * Test-only loopback adapter to the real private Next handler and Prisma DAL.
 * It is not a replacement for the Next proxy, login or browser acceptance.
 * The trusted backend harness owns the temporary PostgreSQL cluster and process.
 */
import { createServer } from 'node:http';
import { NextRequest } from 'next/server';

async function main() {
  const target = new URL(process.env.DATABASE_URL ?? '');
  if (process.env.SHOPGATE_BI_AUTH_TEST_FIXTURE !== 'owned-pg18'
      || target.protocol !== 'postgresql:' || target.hostname !== '127.0.0.1'
      || target.username !== 'jobs_auth_reader' || !target.port
      || !/^\/bi_jobs_test_[a-f0-9]{32}$/.test(target.pathname)
      || target.password || target.search || target.hash
      || process.env.SHOPGATE_AUTH_MODE !== 'local') {
    throw new Error('Only the verifier-owned loopback test database is allowed.');
  }
  // Load the real handler only after validating the explicit disposable target.
  const { POST } = await import('../../src/app/api/internal/bi/job-authorization/route');
  const { BI_JOB_AUTH_PATH } = await import('../../src/lib/bi/job-signatures');
  const { prisma } = await import('../../src/lib/db/client');
  const roles = await prisma.$queryRaw<{ name: string; superuser: boolean; bypass: boolean }[]>`
    SELECT current_user AS name, rolsuper AS superuser, rolbypassrls AS bypass
    FROM pg_roles WHERE rolname=current_user`;
  if (roles.length !== 1 || roles[0].name !== 'jobs_auth_reader'
      || roles[0].superuser || roles[0].bypass) {
    await prisma.$disconnect();
    throw new Error('The authorization fixture requires a nonprivileged reader.');
  }
  let origin = '';
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== BI_JOB_AUTH_PATH) {
      response.writeHead(404).end(); return;
    }
    try {
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers)) {
        if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(',') : value);
      }
      const result = await POST(new NextRequest(origin + BI_JOB_AUTH_PATH, { method: 'POST', headers }));
      response.writeHead(result.status, Object.fromEntries(result.headers.entries()));
      response.end(Buffer.from(await result.arrayBuffer()));
    } catch {
      response.writeHead(500, { 'Cache-Control': 'no-store' }).end();
    } finally { request.resume(); }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No owned loopback port.');
  origin = `http://127.0.0.1:${address.port}`;
  // Port only. Never print sessions, signing values, database URLs or grants.
  console.log(JSON.stringify({ origin, role: roles[0].name }));
  process.once('SIGTERM', () => {
    server.close(() => { void prisma.$disconnect().finally(() => process.exit(0)); });
    server.closeAllConnections();
  });
}

void main().catch(() => {
  console.error('[bi-auth-fixture] Disposable authorization setup failed.');
  process.exitCode = 1;
});
