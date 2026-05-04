export type ErrorCode =
  | 'CREDENTIALS_NOT_FOUND'
  | 'TOKEN_EXPIRED'
  | 'REFRESH_FAILED'
  | 'CLAUDE_EXTRA_USAGE_REQUIRED'
  | 'API_ERROR'
  | 'TIMEOUT'
  | 'INVALID_REQUEST'
  | 'TOOL_NOT_FOUND'
  | 'PRESET_NOT_FOUND'
  | 'HANDLER_ERROR'
  | 'UNKNOWN';

export class BypassError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'BypassError';
  }
}

export const Errors = {
  credentialsNotFound: (msg: string) =>
    new BypassError('CREDENTIALS_NOT_FOUND', msg),

  tokenExpired: (provider: string) =>
    new BypassError('TOKEN_EXPIRED', `${provider} token expired and auto-refresh failed.`),

  refreshFailed: (provider: string, cause?: unknown) =>
    new BypassError('REFRESH_FAILED', `Failed to refresh ${provider} token.`, cause),

  claudeExtraUsageRequired: (providerMessage: string) =>
    new BypassError(
      'CLAUDE_EXTRA_USAGE_REQUIRED',
      'Claude requires extra usage credits for third-party app requests. ' +
      'Add extra usage at https://claude.ai/settings/usage, or switch this request ' +
      'to a non-Claude model such as gpt-5.4. Token refresh or re-login will not ' +
      `fix this until extra usage is enabled. Original Anthropic message: ${providerMessage}`,
    ),

  apiError: (msg: string, cause?: unknown) =>
    new BypassError('API_ERROR', msg, cause),

  timeout: (seconds: number) =>
    new BypassError('TIMEOUT', `Request timed out after ${seconds}s`),

  invalidRequest: (msg: string) =>
    new BypassError('INVALID_REQUEST', msg),

  toolNotFound: (names: string[]) =>
    new BypassError('TOOL_NOT_FOUND', `Tools not found: ${names.join(', ')}`),

  presetNotFound: (name: string) =>
    new BypassError('PRESET_NOT_FOUND', `Preset not found: ${name}`),

  handlerError: (msg: string, cause?: unknown) =>
    new BypassError('HANDLER_ERROR', msg, cause),
};
