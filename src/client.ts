import type {
  ClientOptions,
  SendRequest,
  SendResponse,
  StreamEvent,
  AuthStatus,
  Logger,
  ToolDefinition,
} from './types.js';
import { ClaudeAuth } from './auth/claude-auth.js';
import { CodexAuth } from './auth/codex-auth.js';
import { isClaudeModel } from './providers/router.js';
import { claudeApiCall, claudeApiCallStream } from './providers/claude.js';
import { codexApiCall, codexApiCallStream } from './providers/codex.js';
import { inputToMessages } from './format/input-converter.js';
import { claudeResponseToOpenAI } from './format/output-converter.js';
import { openAIToolsToClaude } from './format/tool-converter.js';
import { createClaudeStreamAdapter, parseCodexStreamEvent } from './format/stream-adapter.js';
import { ToolRegistry } from './tools/registry.js';
import { PresetRegistry } from './tools/presets.js';
import { createRequestQueue, getQueueStats } from './queue/request-queue.js';
import { createDefaultLogger } from './utils/logger.js';
import { Errors } from './utils/errors.js';

export class ProviderBypass {
  private readonly claudeAuth: ClaudeAuth;
  private readonly codexAuth: CodexAuth;
  private readonly queue: ReturnType<typeof createRequestQueue>;
  private readonly logger: Logger;
  private readonly defaultModel: string;
  private readonly defaultTimeout: number;
  private readonly concurrency: number;
  private readonly claudeApiUrl: string | undefined;
  private readonly codexApiUrl: string | undefined;

  readonly tools: ToolRegistry;
  readonly presets: PresetRegistry;

  constructor(options: ClientOptions = {}) {
    this.logger = options.logger || createDefaultLogger();
    this.defaultModel = options.defaultModel || 'claude-sonnet-4-6';
    this.defaultTimeout = options.timeout ?? 10 * 60 * 1000;
    this.concurrency = options.concurrency ?? 3;
    this.claudeApiUrl = options.claude?.apiUrl;
    this.codexApiUrl = options.codex?.apiUrl;

    this.claudeAuth = new ClaudeAuth(options.claude, this.logger);
    this.codexAuth = new CodexAuth(options.codex, this.logger);
    this.queue = createRequestQueue(this.concurrency);
    this.tools = new ToolRegistry();
    this.presets = new PresetRegistry(this.tools);
  }

  /**
   * Non-streaming request. Returns unified OpenAI Responses API format.
   */
  async send(request: SendRequest): Promise<SendResponse> {
    this.validateRequest(request);

    const model = request.model || this.defaultModel;
    const allTools = this.resolveAllTools(request);
    const timeout = request.timeout ?? this.defaultTimeout;

    if (isClaudeModel(model)) {
      return this.sendClaude(model, request, allTools, timeout);
    }

    return this.sendCodex(model, request, allTools, timeout);
  }

  /**
   * Streaming request. Returns an async iterable of StreamEvent objects.
   */
  async *stream(request: SendRequest): AsyncIterable<StreamEvent> {
    this.validateRequest(request);

    const model = request.model || this.defaultModel;
    const allTools = this.resolveAllTools(request);
    const timeout = request.timeout ?? this.defaultTimeout;

    if (isClaudeModel(model)) {
      yield* this.streamClaude(model, request, allTools, timeout);
    } else {
      yield* this.streamCodex(model, request, allTools, timeout);
    }
  }

  /**
   * Returns the current auth status for both providers and queue stats.
   */
  status(): AuthStatus {
    return {
      claude: this.claudeAuth.getTokenInfo(),
      codex: this.codexAuth.getTokenInfo(),
      queue: getQueueStats(this.queue, this.concurrency),
    };
  }

  /**
   * Cleanup file watchers and internal state.
   */
  destroy(): void {
    this.claudeAuth.destroy();
    this.codexAuth.destroy();
    this.tools.clear();
    this.presets.clear();
    this.queue.clear();
  }

  // ─── Private: Claude ───

  private async sendClaude(
    model: string,
    request: SendRequest,
    allTools: ToolDefinition[],
    timeout: number,
  ): Promise<SendResponse> {
    const messages = inputToMessages(request.input);
    const claudeTools = allTools.length > 0 ? openAIToolsToClaude(allTools) : undefined;
    const claudeToolChoice = this.mapToolChoice(request.tool_choice, claudeTools);

    const result = await this.queue.add(() =>
      claudeApiCall(this.claudeAuth, this.claudeApiUrl, {
        model,
        max_tokens: request.max_output_tokens || 16384,
        temperature: request.temperature,
        system: request.instructions,
        messages,
        tools: claudeTools,
        tool_choice: claudeToolChoice,
        cache: request.cache,
        timeout,
      }, request.signal),
    );

    if (!result) throw Errors.apiError('No response from Claude API');

    const { output, usage, id } = claudeResponseToOpenAI(result.response, model, result.latencyMs);

    return {
      id,
      object: 'response',
      model,
      output,
      status: 'completed',
      usage,
      latencyMs: result.latencyMs,
      provider: 'claude',
    };
  }

  private async *streamClaude(
    model: string,
    request: SendRequest,
    allTools: ToolDefinition[],
    timeout: number,
  ): AsyncGenerator<StreamEvent> {
    const messages = inputToMessages(request.input);
    const claudeTools = allTools.length > 0 ? openAIToolsToClaude(allTools) : undefined;
    const claudeToolChoice = this.mapToolChoice(request.tool_choice, claudeTools);

    const events: StreamEvent[] = [];
    let resolveNext: ((value: IteratorResult<StreamEvent>) => void) | null = null;
    let done = false;
    let error: Error | null = null;

    const adapter = createClaudeStreamAdapter((event) => {
      if (resolveNext) {
        const resolve = resolveNext;
        resolveNext = null;
        resolve({ value: event, done: false });
      } else {
        events.push(event);
      }
    });

    const apiPromise = this.queue.add(() =>
      claudeApiCallStream(this.claudeAuth, this.claudeApiUrl, {
        model,
        max_tokens: request.max_output_tokens || 16384,
        temperature: request.temperature,
        system: request.instructions,
        messages,
        tools: claudeTools,
        tool_choice: claudeToolChoice,
        cache: request.cache,
        timeout,
      }, adapter.onRawEvent, request.signal),
    ).then((result) => {
      if (result) {
        adapter.sendCompleted(result.response, model, result.latencyMs);
      }
      done = true;
      if (resolveNext) {
        const resolve = resolveNext;
        resolveNext = null;
        resolve({ value: undefined as any, done: true });
      }
    }).catch((err) => {
      error = err;
      done = true;
      const errEvent: StreamEvent = {
        type: 'error',
        error: { type: 'api_error', message: err.message },
      };
      if (resolveNext) {
        const resolve = resolveNext;
        resolveNext = null;
        resolve({ value: errEvent, done: false });
      } else {
        events.push(errEvent);
      }
    });

    try {
      while (true) {
        if (events.length > 0) {
          yield events.shift()!;
          continue;
        }

        if (done) {
          // Drain remaining events
          while (events.length > 0) {
            yield events.shift()!;
          }
          break;
        }

        // Wait for next event
        const result = await new Promise<IteratorResult<StreamEvent>>((resolve) => {
          resolveNext = resolve;
        });

        if (result.done) break;
        yield result.value;
      }
    } finally {
      await apiPromise.catch(() => {});
    }

    if (error) throw error;
  }

  // ─── Private: Codex ───

  private async sendCodex(
    model: string,
    request: SendRequest,
    allTools: ToolDefinition[],
    timeout: number,
  ): Promise<SendResponse> {
    const result = await this.queue.add(() =>
      codexApiCall(this.codexAuth, this.codexApiUrl, {
        model,
        instructions: request.instructions,
        input: request.input as any,
        tools: allTools.length > 0 ? allTools : undefined,
        tool_choice: request.tool_choice,
        parallel_tool_calls: request.parallel_tool_calls,
        temperature: request.temperature,
        max_output_tokens: request.max_output_tokens,
        reasoning: request.reasoning,
        timeout,
      }, request.signal),
    );

    if (!result) throw Errors.apiError('No response from Codex API');

    return {
      ...result.response,
      latencyMs: result.latencyMs,
      provider: 'codex',
      usage: {
        ...result.response.usage,
      },
    };
  }

  private async *streamCodex(
    model: string,
    request: SendRequest,
    allTools: ToolDefinition[],
    timeout: number,
  ): AsyncGenerator<StreamEvent> {
    const events: StreamEvent[] = [];
    let resolveNext: ((value: IteratorResult<StreamEvent>) => void) | null = null;
    let done = false;
    let error: Error | null = null;

    const streamStart = Date.now();

    const apiPromise = this.queue.add(() =>
      codexApiCallStream(this.codexAuth, this.codexApiUrl, {
        model,
        instructions: request.instructions,
        input: request.input as any,
        tools: allTools.length > 0 ? allTools : undefined,
        tool_choice: request.tool_choice,
        parallel_tool_calls: request.parallel_tool_calls,
        temperature: request.temperature,
        max_output_tokens: request.max_output_tokens,
        reasoning: request.reasoning,
        timeout,
      }, (rawEvent) => {
        const parsed = parseCodexStreamEvent(rawEvent);
        if (!parsed) return;

        // Inject latencyMs and provider into completed events
        if (parsed.type === 'response.completed' && parsed.response) {
          parsed.response.latencyMs = Date.now() - streamStart;
          parsed.response.provider = 'codex';
        }

        if (resolveNext) {
          const resolve = resolveNext;
          resolveNext = null;
          resolve({ value: parsed, done: false });
        } else {
          events.push(parsed);
        }
      }, request.signal),
    ).then(() => {
      done = true;
      if (resolveNext) {
        const resolve = resolveNext;
        resolveNext = null;
        resolve({ value: undefined as any, done: true });
      }
    }).catch((err) => {
      error = err;
      done = true;
      const errEvent: StreamEvent = {
        type: 'error',
        error: { type: 'api_error', message: err.message },
      };
      if (resolveNext) {
        const resolve = resolveNext;
        resolveNext = null;
        resolve({ value: errEvent, done: false });
      } else {
        events.push(errEvent);
      }
    });

    try {
      while (true) {
        if (events.length > 0) {
          yield events.shift()!;
          continue;
        }

        if (done) {
          while (events.length > 0) {
            yield events.shift()!;
          }
          break;
        }

        const result = await new Promise<IteratorResult<StreamEvent>>((resolve) => {
          resolveNext = resolve;
        });

        if (result.done) break;
        yield result.value;
      }
    } finally {
      await apiPromise.catch(() => {});
    }

    if (error) throw error;
  }

  // ─── Private: Helpers ───

  private validateRequest(request: SendRequest): void {
    if (!request.input || !Array.isArray(request.input) || request.input.length === 0) {
      throw Errors.invalidRequest('input array is required and must not be empty');
    }
  }

  private resolveAllTools(request: SendRequest): ToolDefinition[] {
    const inlineTools = request.tools || [];
    let registeredTools: ToolDefinition[] = [];

    if (request.registered_tools && request.registered_tools.length > 0) {
      registeredTools = this.tools.resolveTools(request.registered_tools);
    }

    return [...inlineTools, ...registeredTools];
  }

  private mapToolChoice(
    toolChoice: SendRequest['tool_choice'],
    claudeTools?: any[],
  ): any {
    if (!toolChoice || !claudeTools) return undefined;

    if (toolChoice === 'auto') return { type: 'auto' };
    if (toolChoice === 'required') return { type: 'any' };
    if (toolChoice === 'none') return undefined;
    if (typeof toolChoice === 'object' && 'name' in toolChoice) {
      return { type: 'tool', name: toolChoice.name };
    }

    return undefined;
  }
}

/**
 * Creates a new ProviderBypass client instance.
 */
export function createClient(options?: ClientOptions): ProviderBypass {
  return new ProviderBypass(options);
}
