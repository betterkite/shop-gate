import { describe, expect, it } from 'vitest';

import { getMemoryIntegrationConfig } from './config';

describe('personal memory integration config', () => {
  it('is disabled by default in tests and remains optional', () => {
    const config = getMemoryIntegrationConfig({ NODE_ENV: 'test' });

    expect(config.enabled).toBe(false);
    expect(config.required).toBe(false);
    expect(config.requireProductionReady).toBe(false);
    expect(config.apiUrl).toBe('http://127.0.0.1:38089');
    expect(config.tenantId).toBe('shopgate-local');
    expect(config.timeoutMs).toBe(5_000);
  });

  it('supports an explicitly enabled independent HTTP endpoint', () => {
    const config = getMemoryIntegrationConfig({
      NODE_ENV: 'production',
      SHOPGATE_MEMORY_ENABLED: '1',
      SHOPGATE_MEMORY_REQUIRED: '1',
      SHOPGATE_MEMORY_API_URL: 'https://memory.example/api',
      SHOPGATE_MEMORY_TENANT_ID: 'tenant-a',
      SHOPGATE_MEMORY_TIMEOUT_MS: '900',
      SHOPGATE_MEMORY_TOKEN_BROKER_URL: 'https://identity.example/memory-token',
      SHOPGATE_MEMORY_TOKEN_BROKER_CLIENT_ID: 'shopgate',
      SHOPGATE_MEMORY_TOKEN_BROKER_CLIENT_SECRET: 'x'.repeat(32),
    });

    expect(config).toMatchObject({
      enabled: true,
      required: true,
      requireProductionReady: true,
      apiUrl: 'https://memory.example/api',
      tenantId: 'tenant-a',
      timeoutMs: 900,
      tokenBroker: {
        url: 'https://identity.example/memory-token',
        clientId: 'shopgate',
        clientSecret: 'x'.repeat(32),
        audience: 'evolvable-memory-api',
      },
    });
  });

  it('rejects credentials embedded in the service URL', () => {
    expect(() => getMemoryIntegrationConfig({
      SHOPGATE_MEMORY_API_URL: 'https://user:secret@memory.example',
    })).toThrow('without credentials');
  });

  it('rejects static or absent subject-scoped credentials in production', () => {
    expect(() => getMemoryIntegrationConfig({
      NODE_ENV: 'production',
      SHOPGATE_MEMORY_BEARER_TOKEN: 'static-token',
    })).toThrow('Static personal memory bearer tokens are forbidden');
    expect(() => getMemoryIntegrationConfig({
      NODE_ENV: 'production',
    })).toThrow('requires a scoped token broker');
  });
});
