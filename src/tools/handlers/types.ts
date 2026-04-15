export type HandlerType = 'webhook' | 'rest' | 'script';

export interface WebhookHandlerConfig {
  url: string;
  method?: string;
  headers?: Record<string, string>;
}

export interface RestHandlerConfig {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body_template?: string;
}

export interface ScriptHandlerConfig {
  command: string;
  args?: string[];
  cwd?: string;
  timeout?: number;
}

export type HandlerConfig = WebhookHandlerConfig | RestHandlerConfig | ScriptHandlerConfig;
