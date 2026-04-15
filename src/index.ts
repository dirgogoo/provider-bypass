// Public API
export { createClient, ProviderBypass } from './client.js';

// Types
export type {
  ClientOptions,
  SendRequest,
  SendResponse,
  InputItem,
  MessageInput,
  FunctionCallInput,
  FunctionCallOutputInput,
  ToolDefinition,
  OutputItem,
  MessageOutput,
  FunctionCallOutput,
  ReasoningOutput,
  ContentPart,
  Usage,
  StreamEvent,
  ResponseCreatedEvent,
  OutputItemAddedEvent,
  ContentPartAddedEvent,
  OutputTextDeltaEvent,
  FunctionCallArgumentsDeltaEvent,
  OutputItemDoneEvent,
  ResponseCompletedEvent,
  StreamErrorEvent,
  AuthStatus,
  RegisteredTool,
  WebhookConfig,
  RestConfig,
  ScriptConfig,
  PresetInput,
  Preset,
  Logger,
} from './types.js';

// Errors
export { BypassError } from './utils/errors.js';
export type { ErrorCode } from './utils/errors.js';

// Registries (for type-safe access via client.tools / client.presets)
export { ToolRegistry } from './tools/registry.js';
export { PresetRegistry } from './tools/presets.js';
