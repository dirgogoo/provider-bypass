import type { ClaudeAuth } from '../auth/claude-auth.js';
import type { Logger } from '../types.js';
import { generateId } from '../utils/id-generator.js';
import { Errors } from '../utils/errors.js';

const DEFAULT_API_URL = 'https://api.anthropic.com/v1/messages?beta=true';
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export interface ClaudeMessage {
  role: 'user' | 'assistant';
  content: any;
}

export interface ClaudeTool {
  name: string;
  description: string;
  input_schema: Record<string, any>;
  cache_control?: { type: 'ephemeral' };
}

export interface ClaudeRequestOptions {
  model?: string;
  max_tokens?: number;
  temperature?: number;
  system?: string | Array<{ type: string; text: string; cache_control?: any }>;
  messages: ClaudeMessage[];
  tools?: ClaudeTool[];
  tool_choice?: any;
  stream?: boolean;
  timeout?: number;
  /** Auto-inject cache_control on system/tools/last-message. Default 'auto'. */
  cache?: 'auto' | 'none';
}

export interface ClaudeResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  content: any[];
  model: string;
  stop_reason: string;
  stop_sequence: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

// Required identifier: Anthropic only accepts OAuth Max tokens when the system
// prompt identifies the client as Claude Code. Without this, the API returns
// a misleading HTTP 429 rate_limit_error even when quota is fine.
const CLAUDE_CODE_IDENTIFIER = "You are Claude Code, Anthropic's official CLI for Claude.";

// Per-model output ceiling (mirrors Claude Code's getModelMaxOutputTokens).
// Thinking budget can go up to maxOutputTokens; we reserve 1024 for the answer.
function getModelMaxOutput(model: string): number {
  const m = model.toLowerCase();
  if (m.includes('opus-4-7') || m.includes('opus-4-6') || m.includes('sonnet-4-6')) return 128_000;
  if (m.includes('opus-4-5') || m.includes('sonnet-4') || m.includes('haiku-4') || m.includes('3-7-sonnet')) return 64_000;
  if (m.includes('opus-4-1') || m.includes('opus-4')) return 32_000;
  if (m.includes('claude-3-opus') || m.includes('claude-3-haiku')) return 4_096;
  if (m.includes('claude-3-sonnet') || m.includes('3-5-sonnet') || m.includes('3-5-haiku')) return 8_192;
  return 64_000;
}

const EPHEMERAL: { type: 'ephemeral' } = { type: 'ephemeral' };

/**
 * Apply cache_control: { type: 'ephemeral' } to the last block in an array,
 * without mutating the input. If any block already has cache_control, the
 * caller is assumed to manage breakpoints explicitly and we skip injection.
 */
function markLastWithCache<T extends Record<string, any>>(arr: T[]): T[] {
  if (!arr.length) return arr;
  if (arr.some((b) => b && b.cache_control)) return arr;
  const last = arr[arr.length - 1];
  return [...arr.slice(0, -1), { ...last, cache_control: EPHEMERAL }];
}

/**
 * Attach cache_control to the last content block of the last message, so the
 * evolving conversation prefix is cached turn-to-turn. Uses a "rolling
 * breakpoint": on turn N+1 the last-block marker moves, but Anthropic still
 * matches cache hits at earlier breakpoint boundaries automatically.
 *
 * Handles string vs array content; returns a new messages array (no mutation).
 */
function markLastMessageWithCache(messages: ClaudeMessage[]): ClaudeMessage[] {
  if (!messages.length) return messages;
  const lastIdx = messages.length - 1;
  const last = messages[lastIdx];
  let newContent: any;

  if (typeof last.content === 'string') {
    if (!last.content) return messages;
    newContent = [{ type: 'text', text: last.content, cache_control: EPHEMERAL }];
  } else if (Array.isArray(last.content)) {
    if (!last.content.length) return messages;
    // If caller already marked anything, don't override.
    if (last.content.some((b: any) => b && b.cache_control)) return messages;
    const lastBlockIdx = last.content.length - 1;
    const lastBlock = last.content[lastBlockIdx];
    if (!lastBlock || typeof lastBlock !== 'object') return messages;
    newContent = [
      ...last.content.slice(0, -1),
      { ...lastBlock, cache_control: EPHEMERAL },
    ];
  } else {
    return messages;
  }

  return [...messages.slice(0, -1), { ...last, content: newContent }];
}

function buildRequestBody(options: ClaudeRequestOptions): any {
  const cacheEnabled = options.cache !== 'none';

  let userSystem: any[] = [];

  if (options.system) {
    if (typeof options.system === 'string') {
      userSystem = [{ type: 'text', text: options.system }];
    } else if (Array.isArray(options.system)) {
      userSystem = [...options.system];
    }
  }

  // Always prepend Claude Code identifier (detect if caller already added it
  // to avoid duplication).
  const alreadyPresent = typeof userSystem[0]?.text === 'string'
    && userSystem[0].text.startsWith(CLAUDE_CODE_IDENTIFIER);

  let system = alreadyPresent
    ? userSystem
    : [{ type: 'text', text: CLAUDE_CODE_IDENTIFIER }, ...userSystem];

  if (cacheEnabled) system = markLastWithCache(system);

  const model = options.model || 'claude-sonnet-4-6';
  const modelMaxOutput = getModelMaxOutput(model);
  // Reserve ~1k for the actual answer; the rest is available for thinking.
  const thinkingBudget = Math.max(modelMaxOutput - 1024, 1024);
  const maxTokens = options.max_tokens || modelMaxOutput;

  const messages = cacheEnabled
    ? markLastMessageWithCache(options.messages)
    : options.messages;

  const body: any = {
    model,
    stream: options.stream || false,
    messages,
    system,
  };

  if (options.temperature !== undefined) {
    // User set temperature explicitly — no thinking
    body.temperature = options.temperature;
    body.max_tokens = Math.min(maxTokens, modelMaxOutput);
  } else {
    // Enable thinking by default (requires temperature=1, max_tokens > budget_tokens)
    body.temperature = 1;
    body.thinking = { type: 'enabled', budget_tokens: thinkingBudget };
    body.max_tokens = Math.min(Math.max(maxTokens, thinkingBudget + 1024), modelMaxOutput);
  }

  if (options.tools && options.tools.length > 0) {
    body.tools = cacheEnabled ? markLastWithCache(options.tools) : options.tools;
  }
  if (options.tool_choice) {
    body.tool_choice = options.tool_choice;
  }

  return body;
}

/**
 * Filter out signature blocks from response content (opaque metadata).
 * Thinking blocks are preserved and exposed as reasoning items.
 */
function cleanContent(content: any[]): any[] {
  return (content || [])
    .filter((b: any) => b.type !== 'signature')
    .map((b: any) => {
      const { caller, ...rest } = b;
      return rest;
    });
}

/**
 * Non-streaming API call to Anthropic.
 */
export async function claudeApiCall(
  auth: ClaudeAuth,
  apiUrl: string | undefined,
  options: ClaudeRequestOptions,
  abortSignal?: AbortSignal,
): Promise<{ response: ClaudeResponse; latencyMs: number }> {
  const startTime = Date.now();
  const headers = auth.getHeaders();
  const body = buildRequestBody(options);
  const timeoutMs = options.timeout || DEFAULT_TIMEOUT_MS;
  const url = apiUrl || DEFAULT_API_URL;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  if (abortSignal) {
    abortSignal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    let data: any;
    try {
      data = await res.json();
    } catch {
      throw Errors.apiError(`Claude API Error (http_${res.status}): ${await res.text().catch(() => 'unknown')}`);
    }

    if (!res.ok || data.type === 'error') {
      const errType = data.error?.type || `http_${res.status}`;
      const errMsg = data.error?.message || JSON.stringify(data);
      if (errType === 'rate_limit_error' && errMsg === 'Error') {
        throw Errors.apiError(
          `Claude API Error (${errType}): ${errMsg} — this usually means the ` +
          `system prompt is missing the Claude Code identifier. provider-bypass ` +
          `should prepend it automatically; if you see this, file a bug.`,
        );
      }
      throw Errors.apiError(`Claude API Error (${errType}): ${errMsg}`);
    }

    const latencyMs = Date.now() - startTime;

    const response: ClaudeResponse = {
      id: data.id || generateId('msg'),
      type: 'message',
      role: 'assistant',
      content: cleanContent(data.content),
      model: options.model || data.model || 'claude-sonnet-4-6',
      stop_reason: data.stop_reason || 'end_turn',
      stop_sequence: data.stop_sequence || null,
      usage: {
        input_tokens: data.usage?.input_tokens || 0,
        output_tokens: data.usage?.output_tokens || 0,
        ...(data.usage?.cache_creation_input_tokens && {
          cache_creation_input_tokens: data.usage.cache_creation_input_tokens,
        }),
        ...(data.usage?.cache_read_input_tokens && {
          cache_read_input_tokens: data.usage.cache_read_input_tokens,
        }),
      },
    };

    return { response, latencyMs };
  } catch (err: any) {
    if (err.name === 'AbortError') {
      throw Errors.timeout(timeoutMs / 1000);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    abortSignal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Streaming API call to Anthropic.
 * Filters out signature blocks, remaps content block indices.
 */
export async function claudeApiCallStream(
  auth: ClaudeAuth,
  apiUrl: string | undefined,
  options: ClaudeRequestOptions,
  onEvent: (event: string) => void,
  abortSignal?: AbortSignal,
): Promise<{ response: ClaudeResponse; latencyMs: number }> {
  const startTime = Date.now();
  const headers = auth.getHeaders();
  const body = buildRequestBody({ ...options, stream: true });
  const timeoutMs = options.timeout || DEFAULT_TIMEOUT_MS;
  const url = apiUrl || DEFAULT_API_URL;

  const controller = new AbortController();
  let activeTimer: ReturnType<typeof setTimeout> | null = null;

  function resetTimeout() {
    if (activeTimer) clearTimeout(activeTimer);
    activeTimer = setTimeout(() => controller.abort(), timeoutMs);
  }

  function clearActiveTimeout() {
    if (activeTimer) { clearTimeout(activeTimer); activeTimer = null; }
  }

  resetTimeout();

  const onAbort = () => controller.abort();
  if (abortSignal) {
    abortSignal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok || !res.body) {
      let errMsg: string;
      try {
        const data = await res.json() as any;
        errMsg = `${data.error?.type || 'http_' + res.status}: ${data.error?.message || JSON.stringify(data)}`;
      } catch {
        errMsg = `http_${res.status}: ${await res.text().catch(() => 'unknown')}`;
      }
      throw Errors.apiError(`Claude API Error (${errMsg})`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let responseId = generateId('msg');
    let stopReason = 'end_turn';
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheCreationTokens = 0;
    let cacheReadTokens = 0;

    const skippedBlockIndices = new Set<number>(); // signature blocks only
    const contentBlocks: any[] = [];
    const indexMap = new Map<number, number>();
    let nextCleanIndex = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      resetTimeout();

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;

        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;

        try {
          const event = JSON.parse(data);

          if (event.type === 'message_start' && event.message) {
            responseId = event.message.id || responseId;
            inputTokens = event.message.usage?.input_tokens || 0;
            cacheCreationTokens =
              event.message.usage?.cache_creation_input_tokens || 0;
            cacheReadTokens =
              event.message.usage?.cache_read_input_tokens || 0;
            event.message.content = [];
            delete event.message.context_management;
            onEvent(`event: message_start\ndata: ${JSON.stringify(event)}\n\n`);
            continue;
          }

          if (event.type === 'content_block_start') {
            const blockType = event.content_block?.type;

            if (blockType === 'signature') {
              skippedBlockIndices.add(event.index);
              continue;
            }

            const cleanIndex = nextCleanIndex++;
            indexMap.set(event.index, cleanIndex);

            const { caller, ...cleanBlock } = event.content_block;
            contentBlocks[cleanIndex] = { ...cleanBlock };

            onEvent(`event: content_block_start\ndata: ${JSON.stringify({
              type: 'content_block_start',
              index: cleanIndex,
              content_block: cleanBlock,
            })}\n\n`);
            continue;
          }

          if (event.type === 'content_block_delta') {
            if (skippedBlockIndices.has(event.index)) continue;
            if (event.delta?.type === 'signature_delta') continue;

            const cleanIndex = indexMap.get(event.index);
            if (cleanIndex === undefined) continue;

            if (event.delta?.type === 'text_delta' && contentBlocks[cleanIndex]) {
              contentBlocks[cleanIndex].text =
                (contentBlocks[cleanIndex].text || '') + (event.delta.text || '');
            }

            if (event.delta?.type === 'thinking_delta' && contentBlocks[cleanIndex]) {
              contentBlocks[cleanIndex].thinking =
                (contentBlocks[cleanIndex].thinking || '') + (event.delta.thinking || '');
            }

            onEvent(`event: content_block_delta\ndata: ${JSON.stringify({
              type: 'content_block_delta',
              index: cleanIndex,
              delta: event.delta,
            })}\n\n`);
            continue;
          }

          if (event.type === 'content_block_stop') {
            if (skippedBlockIndices.has(event.index)) continue;

            const cleanIndex = indexMap.get(event.index);
            if (cleanIndex === undefined) continue;

            onEvent(`event: content_block_stop\ndata: ${JSON.stringify({
              type: 'content_block_stop',
              index: cleanIndex,
            })}\n\n`);
            continue;
          }

          if (event.type === 'message_delta') {
            stopReason = event.delta?.stop_reason || stopReason;
            outputTokens = event.usage?.output_tokens || outputTokens;
            onEvent(`event: message_delta\ndata: ${JSON.stringify(event)}\n\n`);
            continue;
          }

          if (event.type === 'message_stop') {
            onEvent(`event: message_stop\ndata: ${JSON.stringify(event)}\n\n`);
            continue;
          }

          if (event.type === 'ping') {
            onEvent(`event: ping\ndata: ${JSON.stringify(event)}\n\n`);
            continue;
          }

          if (event.type === 'error') {
            onEvent(`event: error\ndata: ${JSON.stringify(event)}\n\n`);
            continue;
          }

        } catch {
          // Skip unparseable
        }
      }
    }

    const latencyMs = Date.now() - startTime;

    const response: ClaudeResponse = {
      id: responseId,
      type: 'message',
      role: 'assistant',
      content: contentBlocks.filter(Boolean),
      model: options.model || 'claude-sonnet-4-6',
      stop_reason: stopReason,
      stop_sequence: null,
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        ...(cacheCreationTokens && { cache_creation_input_tokens: cacheCreationTokens }),
        ...(cacheReadTokens && { cache_read_input_tokens: cacheReadTokens }),
      },
    };

    return { response, latencyMs };
  } catch (err: any) {
    if (err.name === 'AbortError') {
      onEvent(`event: error\ndata: ${JSON.stringify({
        type: 'error',
        error: { type: 'timeout_error', message: `Request timed out after ${timeoutMs / 1000}s` },
      })}\n\n`);
      throw Errors.timeout(timeoutMs / 1000);
    }
    throw err;
  } finally {
    clearActiveTimeout();
    abortSignal?.removeEventListener('abort', onAbort);
  }
}
