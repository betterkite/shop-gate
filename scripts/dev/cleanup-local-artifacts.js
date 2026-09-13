#!/usr/bin/env node

const fs = require('fs/promises');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const includeWorkspaceBuilds = args.has('--include-workspace-builds');
const includeVenv = args.has('--include-venv');

const BASE_TARGETS = [
  '.next',
  'out',
  'dist',
  'build',
  'tmp',
  'public/generated',
  'test-results',
  'playwright-report',
  'coverage',
  '.eslintcache',
];

const CACHE_DIR_NAMES = new Set(['__pycache__', '.pytest_cache', '.ruff_cache']);
const WORKSPACE_BUILD_DIR_NAMES = new Set(['.next', 'node_modules', 'dist', 'build', 'out']);

if (args.has('--help') || args.has('-h')) {
  console.log(`Usage: npm run clean:local [-- --dry-run] [-- --include-workspace-builds] [-- --include-venv]

Removes local generated artifacts that are safe to recreate.

Options:
  --dry-run                    Print what would be removed.
  --include-workspace-builds    Also remove build caches inside data/projects/*.
  --include-venv                Also remove Python virtualenvs named .venv.
`);
  process.exit(0);
}

async function exists(targetPath) {
  try {
    await fs.lstat(targetPath);
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
}

async function sizeOf(targetPath) {
  let stat;
  try {
    stat = await fs.lstat(targetPath);
  } catch (error) {
    if (error && error.code === 'ENOENT') return 0;
    throw error;
  }

  if (stat.isSymbolicLink()) {
    return 0;
  }
  if (!stat.isDirectory()) {
    return stat.size;
  }

  let total = 0;
  const entries = await fs.readdir(targetPath, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    total += await sizeOf(path.join(targetPath, entry.name));
  }
  return total;
}

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function relative(targetPath) {
  return path.relative(ROOT, targetPath).replaceAll(path.sep, '/') || '.';
}

async function collectNamedDirs(startDir, names, options = {}) {
  const result = [];
  const maxDepth = options.maxDepth ?? 8;

  async function walk(currentDir, depth) {
    if (depth > maxDepth) return;
    const entries = await fs.readdir(currentDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const child = path.join(currentDir, entry.name);
      if (names.has(entry.name)) {
        result.push(child);
        continue;
      }
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      await walk(child, depth + 1);
    }
  }

  if (await exists(startDir)) {
    await walk(startDir, 0);
  }
  return result;
}

async function collectRootBuildInfo() {
  const entries = await fs.readdir(ROOT, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.tsbuildinfo'))
    .map((entry) => path.join(ROOT, entry.name));
}

async function collectTargets() {
  const targets = new Set(BASE_TARGETS.map((item) => path.join(ROOT, item)));
  for (const target of await collectRootBuildInfo()) {
    targets.add(target);
  }
  for (const target of await collectNamedDirs(ROOT, CACHE_DIR_NAMES, { maxDepth: 5 })) {
    targets.add(target);
  }
  if (includeVenv) {
    for (const target of await collectNamedDirs(ROOT, new Set(['.venv']), { maxDepth: 4 })) {
      targets.add(target);
    }
  }
  if (includeWorkspaceBuilds) {
    const projectsDir = path.join(ROOT, 'data', 'projects');
    for (const target of await collectNamedDirs(projectsDir, WORKSPACE_BUILD_DIR_NAMES, { maxDepth: 3 })) {
      targets.add(target);
    }
  }
  return Array.from(targets).sort();
}

async function main() {
  const targets = [];
  let totalBytes = 0;

  for (const target of await collectTargets()) {
    if (!(await exists(target))) continue;
    const bytes = await sizeOf(target);
    totalBytes += bytes;
    targets.push({ target, bytes });
  }

  if (targets.length === 0) {
    console.log('[clean-local] nothing to remove');
    return;
  }

  for (const { target, bytes } of targets) {
    const label = `${relative(target)} (${formatBytes(bytes)})`;
    if (dryRun) {
      console.log(`[clean-local] would remove ${label}`);
    } else {
      await fs.rm(target, { recursive: true, force: true });
      console.log(`[clean-local] removed ${label}`);
    }
  }

  console.log(
    `[clean-local] ${dryRun ? 'would remove' : 'removed'} ${targets.length} path(s), ${formatBytes(totalBytes)} total`
  );
}

main().catch((error) => {
  console.error('[clean-local] failed');
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
