import type { CodexAuth } from '../auth/codex-auth.js';
import { generateId } from '../utils/id-generator.js';
import { Errors } from '../utils/errors.js';

const DEFAULT_API_URL = 'https://chatgpt.com/backend-api/codex/responses';
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export interface CodexRequestOptions {
  model?: string;
  instructions?: string;
  input: any[];
  tools?: any[];
  tool_choice?: any;
  parallel_tool_calls?: boolean;
  temperature?: number;
  max_output_tokens?: number;
  reasoning?: { summary?: string; effort?: string };
  timeout?: number;
}

export interface CodexResponse {
  id: string;
  object: 'response';
  model: string;
  output: any[];
  status: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
}

const REASONING_MODEL_RE = /^(gpt-5|o1|o3|o4)/i;
const DEFAULT_REASONING_EFFORT = 'xhigh';
const DEFAULT_REASONING_SUMMARY = 'auto';

/**
 * ChatGPT backend always requires stream=true and store=false.
 *
 * For reasoning models (gpt-5.x, o1, o3, o4), we default `reasoning` to
 * `{ effort: "xhigh", summary: "auto" }` when caller did not set them:
 * - `effort: xhigh` maximizes reasoning depth (parity with Claude's
 *   maximized thinking budget).
 * - `summary: auto` keeps the SSE stream alive during long reasoning
 *   phases — without it, edge proxies drop idle connections at ~60-100s,
 *   surfacing as `terminated` errors mid-turn.
 *
 * Explicit caller values always win.
 */
function buildRequestBody(options: CodexRequestOptions): any {
  const model = options.model || 'gpt-5.4';
  const body: any = {
    model,
    input: options.input,
    stream: true,
    store: false,
  };

  body.instructions = options.instructions || 'You are a helpful assistant.';

  // ChatGPT backend does not support max_output_tokens
  if (options.temperature !== undefined) body.temperature = options.temperature;

  const isReasoningModel = REASONING_MODEL_RE.test(model);
  if (isReasoningModel) {
    const incoming = options.reasoning || {};
    body.reasoning = {
      ...incoming,
      effort: incoming.effort ?? DEFAULT_REASONING_EFFORT,
      summary: incoming.summary ?? DEFAULT_REASONING_SUMMARY,
    };
  } else if (options.reasoning) {
    body.reasoning = { ...options.reasoning };
  }

  if (options.tools && options.tools.length > 0) {
    body.tools = options.tools;
    body.tool_choice = options.tool_choice || 'auto';
    body.parallel_tool_calls = options.parallel_tool_calls ?? true;
  }

  return body;
}

/**
 * Non-streaming API call. Internally streams (ChatGPT backend requirement)
 * but collects the full response before returning.
 */
export async function codexApiCall(
  auth: CodexAuth,
  apiUrl: string | undefined,
  options: CodexRequestOptions,
  abortSignal?: AbortSignal,
): Promise<{ response: CodexResponse; latencyMs: number }> {
  return codexApiCallStream(auth, apiUrl, options, () => {}, abortSignal);
}

/**
 * Streaming API call to OpenAI/Codex.
 * Parses SSE events and forwards them to the callback.
 */
export async function codexApiCallStream(
  auth: CodexAuth,
  apiUrl: string | undefined,
  options: CodexRequestOptions,
  onEvent: (event: string) => void,
  abortSignal?: AbortSignal,
): Promise<{ response: CodexResponse; latencyMs: number }> {
  const startTime = Date.now();
  const headers = auth.getHeaders();
  const body = buildRequestBody(options);
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
        errMsg = data.error?.message || data.error?.type || JSON.stringify(data);
      } catch {
        errMsg = await res.text().catch(() => 'unknown');
      }
      throw Errors.apiError(`Codex API Error (${res.status}): ${errMsg}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let responseId = generateId('msg');
    let model = options.model || 'gpt-5.4';
    let status = 'completed';
    let inputTokens = 0;
    let outputTokens = 0;
    const outputBlocks: any[] = [];

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

          if (event.type === 'response.created' || event.type === 'response.completed') {
            if (event.response) {
              responseId = event.response.id || responseId;
              model = event.response.model || model;
              status = event.response.status || status;
              if (event.response.usage) {
                inputTokens = event.response.usage.input_tokens || inputTokens;
                outputTokens = event.response.usage.output_tokens || outputTokens;
              }
            }
          }

          if (event.type === 'response.output_item.done' && event.item) {
            outputBlocks.push(event.item);
          }

          onEvent(`event: ${event.type || 'message'}\ndata: ${JSON.stringify(event)}\n\n`);
        } catch {
          // Skip unparseable
        }
      }
    }

    const latencyMs = Date.now() - startTime;

    const response: CodexResponse = {
      id: responseId,
      object: 'response',
      model,
      output: outputBlocks,
      status,
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
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
