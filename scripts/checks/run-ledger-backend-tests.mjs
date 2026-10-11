// Creates ONLY a new temporary PostgreSQL cluster. No DATABASE_URL from .env is used.
// Executed through the trusted isolated backend verification command.
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
if (process.getuid?.() === 0) throw new Error('Run isolated PostgreSQL tests as an unprivileged user.');
if (!['linux', 'darwin'].includes(process.platform)) {
  throw new Error('Ledger test runner currently supports Linux/macOS; use the isolated Linux verifier.');
}
const binaries = await import(`@embedded-postgres/${process.platform}-${process.arch}`);
const directory = await mkdtemp(path.join(tmpdir(), 'shopgate-ledger-test-'));
const dataDirectory = path.join(directory, 'cluster');
const logFile = path.join(directory, 'postgres.log');
const environment = { ...process.env };
// Discard any user DB URLs; this harness must never run against the daily database.
delete environment.DATABASE_URL;
delete environment.PI_AGENT_TEST_DATABASE_URL;
delete environment.SHOPGATE_LEDGER_TEST_DATABASE_URL;
let started = false;
let exitCode = 1;
try {
  execFileSync('uv', ['run', '--project', 'services/commerce-data',
    'ruff', 'check', 'services/commerce-data'], {
    cwd: root, env: environment, stdio: 'inherit',
  });
  if (process.platform === 'linux') {
    let knownUser = true;
    try { execFileSync('id', ['-un'], { stdio: 'pipe' }); } catch { knownUser = false; }
    if (!knownUser) {
      const helper = path.join(directory, 'uid-lookup.so');
      execFileSync('cc', ['-shared', '-fPIC', '-Wall', '-Werror',
        path.join(root, 'scripts/checks/ledger-verifier-user.c'), '-ldl', '-o', helper],
      { stdio: 'pipe' });
      environment.LD_PRELOAD = helper;
    }
  }
  const port = await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
  execFileSync(binaries.initdb, ['-D', dataDirectory, '-U', 'ledger_test_admin',
    '--auth=trust', '--encoding=UTF8', '--locale=C'], { env: environment, stdio: 'pipe' });
  execFileSync(binaries.pg_ctl, ['-D', dataDirectory, '-l', logFile,
    '-o', `-h 127.0.0.1 -p ${port} -k ${directory}`, '-w', 'start'],
  { env: environment, stdio: 'pipe' });
  started = true;
  const testEnvironment = { ...process.env,
    SHOPGATE_LEDGER_TEST_DATABASE_URL: `postgresql://ledger_test_admin@127.0.0.1:${port}/postgres`,
    SHOPGATE_LEDGER_TEST_CLUSTER: dataDirectory,
    SHOPGATE_LEDGER_TEST_PG_CTL: binaries.pg_ctl,
    SHOPGATE_LEDGER_TEST_PG_ENV: JSON.stringify(environment.LD_PRELOAD
      ? { LD_PRELOAD: environment.LD_PRELOAD } : {}),
  };
  delete testEnvironment.DATABASE_URL;
  delete testEnvironment.PI_AGENT_TEST_DATABASE_URL;
  console.log('[ledger] Dedicated ephemeral PostgreSQL 18; daily database is not used.');
  exitCode = await new Promise((resolve, reject) => {
    const child = spawn('uv', ['run', '--project', 'services/commerce-data',
      'pytest', '-q', 'services/commerce-data/tests'], {
      cwd: root, env: testEnvironment, stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
} catch (error) {
  console.error('[ledger] Verification setup or execution failed:', error.message);
  const log = await readFile(logFile, 'utf8').catch(() => '');
  if (log) console.error(log.slice(-2500));
} finally {
  if (started) {
    try {
      execFileSync(binaries.pg_ctl, ['-D', dataDirectory, '-w', '-m', 'fast', 'stop'],
        { env: environment, stdio: 'pipe' });
    } catch (error) {
      console.error('[ledger] PostgreSQL cleanup failed:', error.message);
      exitCode = 1;
    }
  }
  // Only the mkdtemp-owned cluster, never a caller path or persisted user dataset.
  await rm(directory, { recursive: true, force: true });
}
process.exitCode = exitCode;
