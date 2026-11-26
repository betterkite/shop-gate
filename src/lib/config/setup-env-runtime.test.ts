import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseEnv } from 'node:util';

import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  applyRuntimeEnvUpdates,
  normalizeGeneratedEnvValue,
} = require('../../../scripts/dev/setup-env.js') as {
  applyRuntimeEnvUpdates: (
    updates: Record<string, string>,
    options?: { overwrite?: boolean; target?: Record<string, string | undefined> },
  ) => void;
  normalizeGeneratedEnvValue: (value: string) => string;
};

describe('development setup runtime environment updates', () => {
  it('normalizes quoted values before passing them to child processes', () => {
    expect(normalizeGeneratedEnvValue('"http://localhost:3000"')).toBe(
      'http://localhost:3000',
    );
    expect(normalizeGeneratedEnvValue("'local'")).toBe('local');
    expect(normalizeGeneratedEnvValue('3000')).toBe('3000');
  });

  it('applies newly generated trusted origins during the current launch', () => {
    const target = {
      SHOPGATE_AUTH_TRUSTED_ORIGINS: 'http://localhost:3000',
    };

    applyRuntimeEnvUpdates(
      {
        SHOPGATE_AUTH_TRUSTED_ORIGINS:
          'http://localhost:3000,http://127.0.0.1:3000',
      },
      { target },
    );

    expect(target.SHOPGATE_AUTH_TRUSTED_ORIGINS).toBe(
      'http://localhost:3000,http://127.0.0.1:3000',
    );
  });

  it('does not overwrite an explicit runtime value when requested', () => {
    const target = { DATABASE_URL: 'postgresql://explicit/database' };

    applyRuntimeEnvUpdates(
      { DATABASE_URL: 'postgresql://generated/database' },
      { overwrite: false, target },
    );

    expect(target.DATABASE_URL).toBe('postgresql://explicit/database');
  });
});

describe('database and cache ports after the installation hook', () => {
  const localDb = 'postgresql://dbuser@127.0.0.1';
  const localRedis = 'redis://127.0.0.1';

  it.each([
    { name: 'clean install', existing: '', pg: '35433', redis: '36380' },
    {
      name: 'explicit host ports',
      existing: 'POSTGRES_PORT=35451\nREDIS_PORT=36381',
      pg: '35451',
      redis: '36381',
    },
    {
      name: 'existing URLs',
      existing: `DATABASE_URL=${localDb}:5432/custom\nREDIS_URL=${localRedis}:6379/3`,
      pg: '5432',
      redis: '6379',
    },
    {
      name: 'standard URLs without explicit ports',
      existing: `DATABASE_URL=${localDb}/custom\nREDIS_URL=${localRedis}/3`,
      pg: '5432',
      redis: '6379',
    },
    {
      name: 'URLs supplied by the release runner',
      existing: '',
      env: { DATABASE_URL: `${localDb}:35459/custom`, REDIS_URL: `${localRedis}:36389/3` },
      pg: '35459',
      redis: '36389',
    },
  ])('keeps clients and Compose aligned for $name', ({ existing, env, pg, redis }) => {
    const root = mkdtempSync(path.join(tmpdir(), 'shopgate-port-test-'));
    try {
      const script = path.join(root, 'scripts', 'dev', 'setup-env.js');
      mkdirSync(path.dirname(script), { recursive: true });
      copyFileSync(require.resolve('../../../scripts/dev/setup-env.js'), script);
      const file = path.join(root, '.env');
      writeFileSync(file, existing);
      // Only expose the database settings explicitly supplied by this test case.
      execFileSync(process.execPath, [script], { cwd: root, env: { NODE_ENV: 'test', ...env } });
      const config = parseEnv(readFileSync(file, 'utf8'));
      const original = parseEnv(existing);
      expect(config.POSTGRES_PORT).toBe(pg);
      expect(config.REDIS_PORT).toBe(redis);
      expect(new URL(config.DATABASE_URL!).port || '5432').toBe(pg);
      expect(new URL(config.REDIS_URL!).port || '6379').toBe(redis);
      expect(config).toMatchObject(original);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
