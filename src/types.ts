// ─── Client Options ───

export interface ClientOptions {
  /** Max concurrent requests. Default: 3 */
  concurrency?: number;
  /** Default model when not specified per-request. Default: 'claude-sonnet-4-6' */
  defaultModel?: string;
  /** Request timeout in ms. Default: 600_000 (10 min) */
  timeout?: number;
  /** Custom logger. Default: console-based */
  logger?: Logger;
  /** Claude auth config overrides */
  claude?: {
    credentialPath?: string;
    refreshCommand?: string;
    apiUrl?: string;
  };
  /** Codex auth config overrides */
  codex?: {
    credentialPath?: string;
    refreshCommand?: string;
    apiUrl?: string;
  };
}

// ─── Request / Response ───

export interface SendRequest {
  /** Model name. Routes to Claude or Codex based on prefix. */
  model?: string;
  /** System instructions */
  instructions?: string;
  /** Conversation input in OpenAI Responses format */
  input: InputItem[];
  /** Inline tool definitions (OpenAI function format) */
  tools?: ToolDefinition[];
  /** Names of registered tools to include */
  registered_tools?: string[];
  /** Tool choice strategy */
  tool_choice?: 'auto' | 'required' | 'none' | { name: string };
  /** Allow parallel tool calls (Codex only) */
  parallel_tool_calls?: boolean;
  /** Temperature */
  temperature?: number;
  /** Max output tokens */
  max_output_tokens?: number;
  /** Reasoning config (Codex only) */
  reasoning?: { summary?: string; effort?: string };
  /** Abort signal for cancellation */
  signal?: AbortSignal;
  /** Per-request timeout override (ms) */
  timeout?: number;
}

export type InputItem =
  | MessageInput
  | FunctionCallInput
  | FunctionCallOutputInput;

export interface MessageInput {
  role: 'user' | 'assistant' | 'developer' | 'system';
  content: any;
}

export interface FunctionCallInput {
  type: 'function_call';
  name: string;
  arguments: string;
  call_id: string;
  id?: string;
}

export interface FunctionCallOutputInput {
  type: 'function_call_output';
  call_id: string;
  output: string;
}

export interface ToolDefinition {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, any>;
}

export interface SendResponse {
  id: string;
  object: 'response';
  model: string;
  output: OutputItem[];
  status: string;
  usage: Usage;
  latencyMs: number;
  provider: 'claude' | 'codex';
}

export type OutputItem =
  | MessageOutput
  | FunctionCallOutput
  | ReasoningOutput;

export interface MessageOutput {
  id: string;
  type: 'message';
  status: string;
  role: 'assistant';
  content: ContentPart[];
}

export interface FunctionCallOutput {
  id: string;
  type: 'function_call';
  status: string;
  name: string;
  arguments: string;
  call_id: string;
}

export interface ReasoningOutput {
  id: string;
  type: 'reasoning';
  status: string;
  content: ContentPart[];
}

export interface ContentPart {
  type: 'output_text';
  text: string;
  annotations?: any[];
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

// ─── Streaming ───

export type StreamEvent =
  | ResponseCreatedEvent
  | OutputItemAddedEvent
  | ContentPartAddedEvent
  | OutputTextDeltaEvent
  | FunctionCallArgumentsDeltaEvent
  | OutputItemDoneEvent
  | ResponseCompletedEvent
  | StreamErrorEvent;

export interface ResponseCreatedEvent {
  type: 'response.created';
  response: Partial<SendResponse>;
}

export interface OutputItemAddedEvent {
  type: 'response.output_item.added';
  item: Partial<OutputItem>;
  output_index: number;
}

export interface ContentPartAddedEvent {
  type: 'response.content_part.added';
  part: ContentPart;
  content_index: number;
  item_id: string;
  output_index: number;
}

export interface OutputTextDeltaEvent {
  type: 'response.output_text.delta';
  delta: string;
  content_index: number;
  item_id: string;
  output_index: number;
}

export interface FunctionCallArgumentsDeltaEvent {
  type: 'response.function_call_arguments.delta';
  delta: string;
  item_id: string;
  output_index: number;
}

export interface OutputItemDoneEvent {
  type: 'response.output_item.done';
  item: Partial<OutputItem>;
  output_index: number;
}

export interface ResponseCompletedEvent {
  type: 'response.completed';
  response: SendResponse;
}

export interface StreamErrorEvent {
  type: 'error';
  error: { type: string; message: string };
}

// ─── Auth ───

export interface AuthStatus {
  claude: { valid: boolean; expiresIn: number; subscriptionType: string };
  codex: { valid: boolean; expiresIn: number; authMode: string };
  queue: { concurrency: number; pending: number; active: number; idle: boolean };
}

// ─── Tools ───

export interface RegisteredTool {
  id?: string;
  name: string;
  description: string;
  input_schema: Record<string, any>;
  handler_type: 'webhook' | 'rest' | 'script';
  handler_config: WebhookConfig | RestConfig | ScriptConfig;
  is_enabled?: boolean;
}

export interface WebhookConfig {
  url: string;
  method?: string;
  headers?: Record<string, string>;
}

export interface RestConfig {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body_template?: string;
}

export interface ScriptConfig {
  command: string;
  args?: string[];
  cwd?: string;
  timeout?: number;
}

export interface PresetInput {
  name: string;
  description?: string;
  tool_names: string[];
  settings?: Record<string, any>;
}

export interface Preset extends PresetInput {
  id: string;
}

// ─── Logger ───

export interface Logger {
  info(msg: string, ...args: any[]): void;
  warn(msg: string, ...args: any[]): void;
  error(msg: string, ...args: any[]): void;
  debug(msg: string, ...args: any[]): void;
}
