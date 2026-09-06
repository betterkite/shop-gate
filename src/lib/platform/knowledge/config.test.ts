import { describe, expect, it } from 'vitest';

import { getKnowledgeIntegrationConfig } from './config';

describe('governed knowledge integration config', () => {
  it('is disabled by default in tests', () => {
    const config = getKnowledgeIntegrationConfig({ NODE_ENV: 'test' });

    expect(config.enabled).toBe(false);
    expect(config.required).toBe(false);
    expect(config.apiUrl).toBe('http://localhost:33005');
    expect(config.purpose).toBe('quant-research');
    expect(config.spaces).toEqual(['https://knowledge.local/spaces/default']);
    expect(config.projectSpacesEnabled).toBe(true);
    expect(config.projectSpaceBaseUrl).toBe('https://knowledge.local/spaces/shopgate/projects');
  });

  it('accepts an independent AKEP endpoint and bounded scope', () => {
    const config = getKnowledgeIntegrationConfig({
      NODE_ENV: 'development',
      SHOPGATE_KNOWLEDGE_ENABLED: '1',
      SHOPGATE_KNOWLEDGE_REQUIRED: '1',
      SHOPGATE_KNOWLEDGE_API_URL: 'https://knowledge.example/platform',
      SHOPGATE_KNOWLEDGE_PURPOSE: 'quant-research',
      SHOPGATE_KNOWLEDGE_SPACES: 'https://knowledge.example/spaces/research,https://knowledge.example/spaces/risk',
      SHOPGATE_KNOWLEDGE_PROJECT_SPACE_BASE_URL: 'https://knowledge.example/spaces/projects/',
      SHOPGATE_KNOWLEDGE_TIMEOUT_MS: '900',
      SHOPGATE_KNOWLEDGE_MAX_CONTEXT_CHARACTERS: '6000',
      SHOPGATE_KNOWLEDGE_BEARER_TOKEN: 'test-reader',
    });

    expect(config).toMatchObject({
      enabled: true,
      required: true,
      apiUrl: 'https://knowledge.example/platform',
      purpose: 'quant-research',
      timeoutMs: 900,
      maxContextCharacters: 6000,
      bearerToken: 'test-reader',
    });
    expect(config.spaces).toHaveLength(2);
    expect(config.projectSpaceBaseUrl).toBe('https://knowledge.example/spaces/projects');
  });

  it('requires OAuth and HTTPS in production', () => {
    expect(() => getKnowledgeIntegrationConfig({
      NODE_ENV: 'production',
      SHOPGATE_KNOWLEDGE_ENABLED: '1',
      SHOPGATE_KNOWLEDGE_API_URL: 'https://knowledge.example',
    })).toThrow('requires OAuth client credentials');
    expect(() => getKnowledgeIntegrationConfig({
      NODE_ENV: 'production',
      SHOPGATE_KNOWLEDGE_ENABLED: '1',
      SHOPGATE_KNOWLEDGE_API_URL: 'http://knowledge.example',
    })).toThrow('must use HTTPS');
  });
});
