import WebSocket from 'ws';
import type { CodexAuth } from '../auth/codex-auth.js';
import { generateId } from '../utils/id-generator.js';
import { getInstallationId } from '../utils/installation-id.js';
import { Errors } from '../utils/errors.js';

const DEFAULT_WS_URL = 'wss://chatgpt.com/backend-api/codex/responses';
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const RESPONSES_BETA = 'responses_websockets=2026-02-06';
const CODEX_VERSION = '0.124.0';
const ORIGINATOR = 'codex_exec';

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
  /** Session UUID reused across calls → stable prompt_cache_key → cache hits. */
  sessionId?: string;
}

export interface CodexUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  /** Tokens served from prompt cache (0 when cache miss). */
  cached_tokens?: number;
  /** Reasoning tokens (subset of output_tokens for reasoning models). */
  reasoning_tokens?: number;
}

export interface CodexResponse {
  id: string;
  object: 'response';
  model: string;
  output: any[];
  status: string;
  usage: CodexUsage;
}

const REASONING_MODEL_RE = /^(gpt-5|o1|o3|o4)/i;
const DEFAULT_REASONING_EFFORT = 'xhigh';
const DEFAULT_REASONING_SUMMARY = 'auto';

/**
 * Build the WebSocket request frame (`type: "response.create"`).
 *
 * Reproduces the payload shape captured from codex-cli v0.124.0:
 * the same fields, in the same order, with `prompt_cache_key` set to
 * the caller's session UUID so that consecutive turns can reuse cached
 * prefix tokens (observed ~19% cache hit on the second turn, growing
 * as the conversation gets longer).
 */
function buildFrame(options: CodexRequestOptions, sessionId: string): Record<string, any> {
  const model = options.model || 'gpt-5.4';
  const isReasoning = REASONING_MODEL_RE.test(model);

  const reasoning = isReasoning
    ? {
        effort: options.reasoning?.effort ?? DEFAULT_REASONING_EFFORT,
        summary: options.reasoning?.summary ?? DEFAULT_REASONING_SUMMARY,
        ...options.reasoning,
      }
    : options.reasoning
    ? { ...options.reasoning }
    : undefined;

  const frame: Record<string, any> = {
    type: 'response.create',
    model,
    instructions: options.instructions || 'You are a helpful assistant.',
    input: options.input,
    store: false,
    stream: true,
    include: ['reasoning.encrypted_content'],
    prompt_cache_key: sessionId,
    text: { verbosity: 'low' },
    client_metadata: {
      'x-codex-window-id': `${sessionId}:0`,
      'x-codex-installation-id': getInstallationId(),
      'x-codex-turn-metadata': JSON.stringify({
        session_id: sessionId,
        thread_source: 'user',
        turn_id: '',
        workspaces: {},
        sandbox: 'none',
      }),
    },
  };

  if (reasoning) frame.reasoning = reasoning;
  if (options.temperature !== undefined) frame.temperature = options.temperature;
  if (options.tools && options.tools.length > 0) {
    frame.tools = options.tools;
    frame.tool_choice = options.tool_choice || 'auto';
    frame.parallel_tool_calls = options.parallel_tool_calls ?? true;
  }

  return frame;
}

function buildHandshakeHeaders(accessToken: string, accountId: string | undefined, sessionId: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${accessToken}`,
    'openai-beta': RESPONSES_BETA,
    'x-codex-window-id': `${sessionId}:0`,
    'x-client-request-id': sessionId,
    'session_id': sessionId,
    'originator': ORIGINATOR,
    'version': CODEX_VERSION,
    'User-Agent': `codex_exec/${CODEX_VERSION}`,
  };
  if (accountId) headers['chatgpt-account-id'] = accountId;
  return headers;
}

/**
 * Non-streaming API call. Internally streams and collects the full response.
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
 * Streaming API call to OpenAI/Codex over WebSocket.
 *
 * The Codex backend is WebSocket-only since v0.124.0. The HTTP POST
 * variant silently disables prompt caching (backend overrides the
 * caller's `prompt_cache_key` with a per-request UUID). The WS variant
 * honors the key, enabling cross-turn cache reuse.
 *
 * `onEvent` receives raw SSE-formatted strings (`event: <type>\ndata: <json>\n\n`)
 * for back-compat with the old transport and the stream-adapter.
 */
export async function codexApiCallStream(
  auth: CodexAuth,
  apiUrl: string | undefined,
  options: CodexRequestOptions,
  onEvent: (event: string) => void,
  abortSignal?: AbortSignal,
): Promise<{ response: CodexResponse; latencyMs: number }> {
  const creds = auth.getCredentials();
  const sessionId = options.sessionId || generateSessionUuid();
  const timeoutMs = options.timeout || DEFAULT_TIMEOUT_MS;
  const url = apiUrl || DEFAULT_WS_URL;

  const headers = buildHandshakeHeaders(creds.accessToken, creds.accountId, sessionId);
  const frame = buildFrame(options, sessionId);

  const startedAt = Date.now();
  let model = options.model || 'gpt-5.4';
  let responseId = generateId('msg');
  let status = 'completed';
  let usage: CodexUsage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  const outputBlocks: any[] = [];

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });

    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    // One-shot settle helper — runs fn once, cleans up timers/listeners/ws.
    // IMPORTANT: install ws event handlers BEFORE any code path that could
    // close/terminate the socket (otherwise ws emits 'error' during CONNECTING
    // with no listener and Node crashes with unhandled event).
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) { clearTimeout(timer); timer = null; }
      if (abortSignal) abortSignal.removeEventListener('abort', onAbort);
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        try { ws.close(); } catch { /* ignore */ }
      }
      fn();
    };

    const onAbort = () => settle(() => reject(new Error('Request aborted')));

    // ─── Handlers first — before any abort/close that could fire 'error' ───
    ws.on('error', (err: any) => {
      settle(() => reject(Errors.apiError(`Codex WS error: ${err?.message || err}`)));
    });

    ws.on('close', (code: number, reason: Buffer) => {
      const detail = reason?.toString('utf-8') || '';
      settle(() => reject(Errors.apiError(`Codex WS closed (${code})${detail ? `: ${detail}` : ''}`)));
    });

    // Handshake HTTP failures (401, 403, 429 from upgrade)
    ws.on('unexpected-response', (_req, res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk.toString('utf-8'); });
      res.on('end', () => settle(() => reject(Errors.apiError(`Codex WS handshake failed (${res.statusCode}): ${body.slice(0, 400)}`))));
      res.on('error', () => settle(() => reject(Errors.apiError(`Codex WS handshake failed (${res.statusCode})`))));
    });

    ws.on('open', () => {
      try {
        ws.send(JSON.stringify(frame));
      } catch (err: any) {
        settle(() => reject(Errors.apiError(`Codex WS send failed: ${err?.message || err}`)));
      }
    });

    ws.on('message', (data) => {
      if (settled) return;
      resetTimer();

      let event: any;
      try {
        event = JSON.parse(data.toString('utf-8'));
      } catch {
        return; // skip unparseable
      }

      // Forward to caller in SSE format (back-compat with parseCodexStreamEvent)
      onEvent(`event: ${event.type || 'message'}\ndata: ${JSON.stringify(event)}\n\n`);

      // Track state for final response
      if (event.type === 'response.created' || event.type === 'response.completed') {
        if (event.response) {
          responseId = event.response.id || responseId;
          model = event.response.model || model;
          status = event.response.status || status;
          if (event.response.usage) {
            usage = extractUsage(event.response.usage);
          }
        }
      }

      if (event.type === 'response.output_item.done' && event.item) {
        outputBlocks.push(event.item);
      }

      if (event.type === 'response.completed') {
        const latencyMs = Date.now() - startedAt;
        settle(() => resolve({
          response: {
            id: responseId,
            object: 'response',
            model,
            output: outputBlocks,
            status,
            usage,
          },
          latencyMs,
        }));
      }
    });

    // Timer (per-message reset to catch stalls mid-stream)
    const resetTimer = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        onEvent(`event: error\ndata: ${JSON.stringify({
          type: 'error',
          error: { type: 'timeout_error', message: `Request timed out after ${timeoutMs / 1000}s` },
        })}\n\n`);
        settle(() => reject(Errors.timeout(timeoutMs / 1000)));
      }, timeoutMs);
    };
    resetTimer();

    // Abort wiring — AFTER handlers so any emissions have listeners.
    if (abortSignal) {
      if (abortSignal.aborted) {
        settle(() => reject(new Error('Request aborted')));
        return;
      }
      abortSignal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

function extractUsage(raw: any): CodexUsage {
  const input = raw?.input_tokens || 0;
  const output = raw?.output_tokens || 0;
  const cached = raw?.input_tokens_details?.cached_tokens;
  const reasoning = raw?.output_tokens_details?.reasoning_tokens;
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: raw?.total_tokens || input + output,
    ...(typeof cached === 'number' ? { cached_tokens: cached } : {}),
    ...(typeof reasoning === 'number' ? { reasoning_tokens: reasoning } : {}),
  };
}

function generateSessionUuid(): string {
  // Fallback when caller didn't supply sessionId. Each call gets a fresh UUID;
  // cache won't hit across calls unless the caller reuses sessionId explicitly.
  return globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : require('node:crypto').randomUUID();
}
