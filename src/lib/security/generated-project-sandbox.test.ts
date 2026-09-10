import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildGeneratedProjectEnv, wrapGeneratedProjectCommand } from './generated-project-sandbox';

afterEach(() => {
  delete process.env.SHOPGATE_ALLOW_UNSANDBOXED_GENERATED_CODE;
  delete process.env.SHOPGATE_GENERATED_SANDBOX;
});

describe('generated project sandbox', () => {
  it('uses an explicit minimal environment without platform secrets', () => {
    const env = buildGeneratedProjectEnv('/tmp/project', {
      PATH: '/usr/bin',
      PORT: '4100',
      SHOPGATE_SANDBOX_PREVIEW_SOCKET: '/tmp/project/.next/preview.sock',
      SHOPGATE_SANDBOX_PREVIEW_PORT: '4100',
      SHOPGATE_SANDBOX_MARKET_SOCKET: '/tmp/project/.next/market.sock',
      SHOPGATE_SANDBOX_MARKET_PORT: '8000',
      DEEPSEEK_API_KEY: 'must-not-leak',
      DATABASE_URL: 'must-not-leak',
    });
    expect(env).toMatchObject({
      PATH: '/usr/bin',
      PORT: '4100',
      SHOPGATE_SANDBOX_PREVIEW_SOCKET: '/tmp/project/.next/preview.sock',
      SHOPGATE_SANDBOX_PREVIEW_PORT: '4100',
      SHOPGATE_SANDBOX_MARKET_SOCKET: '/tmp/project/.next/market.sock',
      SHOPGATE_SANDBOX_MARKET_PORT: '8000',
      NEXT_TELEMETRY_DISABLED: '1',
      SHOPGATE_WORKSPACE_ROOT: '/tmp/project',
    });
    expect(env).not.toHaveProperty('DEEPSEEK_API_KEY');
    expect(env).not.toHaveProperty('DATABASE_URL');
  });

  it.runIf(process.platform === 'linux')('wraps commands in user, mount, network, and PID namespaces', async () => {
    const projectPath = path.resolve('data/projects');
    const wrapped = await wrapGeneratedProjectCommand(projectPath, 'npm', ['run', 'build']);
    expect(wrapped.command).toBe('unshare');
    expect(wrapped.args).toEqual(expect.arrayContaining([
      '--user',
      '--map-root-user',
      '--mount',
      '--net',
      '--pid',
      '--fork',
      'npm',
      'run',
      'build',
    ]));
  });

  it.runIf(process.platform === 'linux')('requires the paired explicit override before disabling the Linux sandbox', async () => {
    const projectPath = path.resolve('data/projects');
    process.env.SHOPGATE_GENERATED_SANDBOX = '0';

    await expect(
      wrapGeneratedProjectCommand(projectPath, 'npm', ['run', 'build']),
    ).rejects.toThrow('explicit unsafe override');

    process.env.SHOPGATE_ALLOW_UNSANDBOXED_GENERATED_CODE = '1';
    await expect(
      wrapGeneratedProjectCommand(projectPath, 'npm', ['run', 'build']),
    ).resolves.toEqual({ command: 'npm', args: ['run', 'build'] });
  });

  it.runIf(process.platform !== 'linux')('requires the Linux sandbox before allowing a direct command outside Linux', async () => {
    const projectPath = path.resolve('data/projects');

    await expect(
      wrapGeneratedProjectCommand(projectPath, 'npm', ['run', 'build']),
    ).rejects.toThrow('requires the Linux namespace sandbox');

    process.env.SHOPGATE_ALLOW_UNSANDBOXED_GENERATED_CODE = '1';
    await expect(
      wrapGeneratedProjectCommand(projectPath, 'npm', ['run', 'build']),
    ).resolves.toEqual({ command: 'npm', args: ['run', 'build'] });
  });
});
