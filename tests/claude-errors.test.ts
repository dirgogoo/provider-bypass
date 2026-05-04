import { describe, expect, it } from 'vitest';
import { claudeApiError } from '../src/providers/claude';
import { BypassError } from '../src/utils/errors';

describe('claudeApiError', () => {
  it('classifies Anthropic extra usage errors', () => {
    const err = claudeApiError(
      'invalid_request_error',
      'Third-party apps now draw from your extra usage, not your plan limits. Add more at claude.ai/settings/usage and keep going.',
    );

    expect(err).toBeInstanceOf(BypassError);
    expect((err as BypassError).code).toBe('CLAUDE_EXTRA_USAGE_REQUIRED');
    expect(err.message).toContain('https://claude.ai/settings/usage');
    expect(err.message).toContain('Token refresh or re-login will not fix this');
  });

  it('keeps generic Claude API errors generic', () => {
    const err = claudeApiError('invalid_request_error', 'model is required');

    expect(err).toBeInstanceOf(BypassError);
    expect((err as BypassError).code).toBe('API_ERROR');
    expect(err.message).toBe('Claude API Error (invalid_request_error): model is required');
  });
});
