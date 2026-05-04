import { describe, expect, it } from 'vitest';
import { buildRequestBody } from '../src/providers/claude';

describe('buildRequestBody', () => {
  it('uses adaptive max-effort reasoning by default for modern Claude models', () => {
    const body = buildRequestBody({
      model: 'claude-opus-4-7',
      messages: [{ role: 'user', content: 'ping' }],
      cache: 'none',
    });

    expect(body.max_tokens).toBe(32_000);
    expect(body.temperature).toBeUndefined();
    expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(body.output_config).toEqual({ effort: 'max' });
  });

  it('omits summarized reasoning when summary is none', () => {
    const body = buildRequestBody({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'ping' }],
      reasoning: { summary: 'none', effort: 'high' },
      cache: 'none',
    });

    expect(body.thinking).toEqual({ type: 'adaptive', display: 'omitted' });
    expect(body.output_config).toEqual({ effort: 'high' });
  });

  it('maps normalized xhigh reasoning to Claude max', () => {
    const body = buildRequestBody({
      model: 'claude-opus-4-7',
      messages: [{ role: 'user', content: 'ping' }],
      reasoning: { effort: 'xhigh', summary: 'auto' },
      cache: 'none',
    });

    expect(body.output_config).toEqual({ effort: 'max' });
  });

  it('respects explicit max tokens without re-expanding them for thinking', () => {
    const body = buildRequestBody({
      model: 'claude-opus-4-7',
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 16_384,
      cache: 'none',
    });

    expect(body.max_tokens).toBe(16_384);
    expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
  });

  it('does not send deprecated temperature for adaptive-thinking Claude models', () => {
    const body = buildRequestBody({
      model: 'claude-opus-4-7',
      messages: [{ role: 'user', content: 'ping' }],
      temperature: 0,
      cache: 'none',
    });

    expect(body.temperature).toBeUndefined();
  });
});
