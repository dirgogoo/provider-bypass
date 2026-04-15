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

function buildRequestBody(options: ClaudeRequestOptions): any {
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

  const system = alreadyPresent
    ? userSystem
    : [{ type: 'text', text: CLAUDE_CODE_IDENTIFIER }, ...userSystem];

  const thinkingBudget = 16000;
  const maxTokens = options.max_tokens || 16384;

  const body: any = {
    model: options.model || 'claude-sonnet-4-6',
    stream: options.stream || false,
    messages: options.messages,
    system,
  };

  if (options.temperature !== undefined) {
    // User set temperature explicitly — no thinking
    body.temperature = options.temperature;
    body.max_tokens = maxTokens;
  } else {
    // Enable thinking by default (requires temperature=1, max_tokens > budget_tokens)
    body.temperature = 1;
    body.thinking = { type: 'enabled', budget_tokens: thinkingBudget };
    body.max_tokens = Math.max(maxTokens, thinkingBudget + 1024);
  }

  if (options.tools && options.tools.length > 0) {
    body.tools = options.tools;
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
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
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
