import { describe, expect, it } from 'vitest';
import { isRuntimeOnlyChatProjection } from './message';

describe('PI Agent conversation history projection filter', () => {
  it('drops intermediate and hidden platform/model narration', () => {
    expect(isRuntimeOnlyChatProjection({
      role: 'assistant',
      metadataJson: JSON.stringify({ isWorkspaceProgress: true, progressStep: 2 }),
    })).toBe(true);
    expect(isRuntimeOnlyChatProjection({
      role: 'assistant',
      metadataJson: JSON.stringify({ isPiAgentIntermediateTurn: true }),
    })).toBe(true);
    expect(isRuntimeOnlyChatProjection({
      role: 'assistant',
      metadataJson: JSON.stringify({ hidden_from_ui: true }),
    })).toBe(true);
  });

  it('keeps the accepted final workspace projection and all user messages', () => {
    expect(isRuntimeOnlyChatProjection({
      role: 'assistant',
      metadataJson: JSON.stringify({
        isWorkspaceProgress: true,
        isPiAgentFinal: true,
        progressStep: 5,
      }),
    })).toBe(false);
    expect(isRuntimeOnlyChatProjection({
      role: 'user',
      metadataJson: JSON.stringify({ isMissionIntermediate: true }),
    })).toBe(false);
  });

  it('omits explicitly hidden user input only when building the read-only archive', () => {
    const hidden = { role: 'user' as const, metadataJson: '{"hidden_from_ui":true}' };
    expect(isRuntimeOnlyChatProjection(hidden)).toBe(false);
    expect(isRuntimeOnlyChatProjection(hidden, true)).toBe(true);
    expect(isRuntimeOnlyChatProjection({ role: 'user', metadataJson: '{"isMissionIntermediate":true}' }, true)).toBe(false);
  });

  it('fails open for malformed legacy metadata', () => {
    expect(isRuntimeOnlyChatProjection({
      role: 'assistant',
      metadataJson: '{invalid',
    })).toBe(false);
  });
});
