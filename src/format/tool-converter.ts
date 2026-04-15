import type { ToolDefinition } from '../types.js';

interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, any>;
}

/**
 * Convert OpenAI function tools → Anthropic tools.
 */
export function openAIToolsToClaude(tools: ToolDefinition[]): AnthropicTool[] {
  return tools
    .filter((t) => t.type === 'function')
    .map((t) => ({
      name: t.name,
      description: t.description || '',
      input_schema: t.parameters || { type: 'object', properties: {} },
    }));
}

/**
 * Convert Anthropic tools → OpenAI function tools.
 */
export function claudeToolsToOpenAI(tools: AnthropicTool[]): ToolDefinition[] {
  return tools.map((t) => ({
    type: 'function' as const,
    name: t.name,
    description: t.description,
    parameters: t.input_schema,
  }));
}
