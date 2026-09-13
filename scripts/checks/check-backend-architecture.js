#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const root = process.cwd();
const failures = [];

function absolute(relativePath) {
  return path.join(root, relativePath);
}

function exists(relativePath) {
  return fs.existsSync(absolute(relativePath));
}

function read(relativePath) {
  return fs.readFileSync(absolute(relativePath), 'utf8');
}

function fail(message) {
  failures.push(message);
}

function requireFile(relativePath, terms = []) {
  if (!exists(relativePath)) {
    fail(`missing commerce-data architecture file: ${relativePath}`);
    return '';
  }
  const content = read(relativePath);
  for (const term of terms) {
    if (!content.includes(term)) fail(`${relativePath} should mention "${term}"`);
  }
  return content;
}

const api = requireFile('services/commerce-data/src/shopgate_commerce_data/api.py', [
  'create_commerce_router',
  'include_router(create_commerce_router())',
  'Shop Gate Commerce Data API',
]);
requireFile('services/commerce-data/src/shopgate_commerce_data/cli.py', [
  'COMMERCE_ENVIRONMENT_KEYS',
  'shopgate_commerce_data.api:app',
]);
requireFile('services/commerce-data/src/shopgate_commerce_data/import_cli.py', [
  'import-userbehavior',
  'generate-synthetic-behavior',
  'aggregate-daily',
]);
requireFile('services/commerce-data/src/shopgate_commerce_data/retail.py', [
  'commerce.user_behavior_events',
  'behavior_funnel',
  'inventory_risk',
]);
requireFile('services/commerce-data/src/shopgate_commerce_data/routers/commerce.py', [
  'APIRouter(prefix="/api/v1/commerce"',
  'create_commerce_router',
]);
requireFile('services/commerce-data/src/shopgate_commerce_data/database_core.py', [
  'async def connect',
]);
requireFile('services/commerce-data/src/shopgate_commerce_data/cache.py', [
  'class RedisJsonCache',
]);

if (api.includes('routers.analytics') || api.includes('routers.quotes')) {
  fail('api.py must not import legacy financial routers');
}

const forbiddenPaths = [
  'services/commerce-data/src/shopgate_commerce_data/backtest.py',
  'services/commerce-data/src/shopgate_commerce_data/clickhouse.py',
  'services/commerce-data/src/shopgate_commerce_data/fundamentals.py',
  'services/commerce-data/src/shopgate_commerce_data/indicators.py',
  'services/commerce-data/src/shopgate_commerce_data/provider_candidates.py',
  'services/commerce-data/src/shopgate_commerce_data/models.py',
  'services/commerce-data/src/shopgate_commerce_data/providers',
  'services/commerce-data/src/shopgate_commerce_data/services',
  'services/commerce-data/src/shopgate_commerce_data/repositories',
  'services/commerce-data/src/shopgate_commerce_data/routers/analytics.py',
  'services/commerce-data/src/shopgate_commerce_data/routers/backtests.py',
  'services/commerce-data/src/shopgate_commerce_data/routers/events.py',
  'services/commerce-data/src/shopgate_commerce_data/routers/foundation.py',
  'services/commerce-data/src/shopgate_commerce_data/routers/fundamentals.py',
  'services/commerce-data/src/shopgate_commerce_data/routers/indicators.py',
  'services/commerce-data/src/shopgate_commerce_data/routers/ingestion.py',
  'services/commerce-data/src/shopgate_commerce_data/routers/quotes.py',
  'services/commerce-data/src/shopgate_commerce_data/routers/research.py',
];
for (const relativePath of forbiddenPaths) {
  if (exists(relativePath)) fail(`legacy commerce-data path must be removed: ${relativePath}`);
}

const pyproject = requireFile('services/commerce-data/pyproject.toml');
for (const term of ['clickhouse', 'akshare', 'baostock', 'tushare']) {
  if (pyproject.toLowerCase().includes(term)) {
    fail(`pyproject.toml must not retain legacy finance dependency: ${term}`);
  }
}

const packageJson = JSON.parse(requireFile('package.json'));
if (!packageJson.scripts?.['check:backend-architecture']) {
  fail('package.json should expose check:backend-architecture');
}

const trackedFiles = [];
function walk(relativeDirectory) {
  const directory = absolute(relativeDirectory);
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relativePath = path.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) walk(relativePath);
    else if (entry.name.endsWith('.py')) trackedFiles.push(relativePath);
  }
}
walk('services/commerce-data/src/shopgate_commerce_data');
for (const file of trackedFiles) {
  const source = read(file);
  if (/shopgate_commerce_data\.(providers|services|repositories|models|backtest|clickhouse|fundamentals|indicators)/.test(source)) {
    fail(`${file} contains an import from removed financial commerce-data modules`);
  }
  if (source.includes('shopgate_commerce_data.database import')) {
    fail(`${file} must not import removed database.py facade`);
  }
}

if (failures.length > 0) {
  for (const message of failures) console.error(`[backend-architecture] ${message}`);
  process.exit(1);
}

console.log('[backend-architecture] ok');
