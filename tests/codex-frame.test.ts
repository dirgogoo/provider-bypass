import { describe, expect, it } from 'vitest';
import { buildFrame } from '../src/providers/codex';

describe('buildFrame', () => {
  it('uses the strongest Codex wire effort for gpt-5.5 without unsupported max_output_tokens', () => {
    const frame = buildFrame({
      model: 'gpt-5.5',
      input: [{ role: 'user', content: 'ping' }],
      max_output_tokens: 16,
    }, '00000000-0000-4000-8000-000000000000');

    expect(frame.reasoning).toEqual({ effort: 'xhigh', summary: 'auto' });
    expect(frame).not.toHaveProperty('max_output_tokens');
  });

  it('maps normalized max reasoning to Codex xhigh', () => {
    const frame = buildFrame({
      model: 'gpt-5.5',
      input: [{ role: 'user', content: 'ping' }],
      reasoning: { effort: 'max', summary: 'auto' },
    }, '00000000-0000-4000-8000-000000000000');

    expect(frame.reasoning).toEqual({ effort: 'xhigh', summary: 'auto' });
  });

  it('passes explicit normalized reasoning through to Codex models', () => {
    const frame = buildFrame({
      model: 'gpt-5.5',
      input: [{ role: 'user', content: 'ping' }],
      reasoning: { effort: 'high', summary: 'none' },
    }, '00000000-0000-4000-8000-000000000000');

    expect(frame.reasoning).toEqual({ effort: 'high', summary: 'none' });
  });
});
