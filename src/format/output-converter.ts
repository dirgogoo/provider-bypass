import type { OutputItem, Usage } from '../types.js';
import { generateId } from '../utils/id-generator.js';

interface ClaudeResponse {
  id?: string;
  content?: any[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  [key: string]: any;
}

/**
 * Convert Anthropic Messages API response → OpenAI Responses API format.
 */
export function claudeResponseToOpenAI(
  claudeRes: ClaudeResponse,
  model: string,
  latencyMs: number,
): { output: OutputItem[]; usage: Usage; id: string } {
  const output: OutputItem[] = [];

  for (const block of claudeRes.content || []) {
    if (block.type === 'text') {
      output.push({
        id: generateId('msg'),
        type: 'message',
        status: 'completed',
        content: [{
          type: 'output_text',
          annotations: [],
          text: block.text,
        }],
        role: 'assistant',
      });
    }

    if (block.type === 'tool_use') {
      output.push({
        id: block.id || generateId('msg'),
        type: 'function_call',
        status: 'completed',
        name: block.name,
        arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input),
        call_id: block.id || generateId('toolu'),
      });
    }

    if (block.type === 'thinking') {
      output.push({
        id: generateId('msg'),
        type: 'reasoning',
        status: 'completed',
        content: [{
          type: 'output_text',
          text: block.thinking,
        }],
      });
    }
  }

  const usage: Usage = {
    input_tokens: claudeRes.usage?.input_tokens || 0,
    output_tokens: claudeRes.usage?.output_tokens || 0,
    total_tokens: (claudeRes.usage?.input_tokens || 0) + (claudeRes.usage?.output_tokens || 0),
    ...(claudeRes.usage?.cache_creation_input_tokens && {
      cache_creation_input_tokens: claudeRes.usage.cache_creation_input_tokens,
    }),
    ...(claudeRes.usage?.cache_read_input_tokens && {
      cache_read_input_tokens: claudeRes.usage.cache_read_input_tokens,
    }),
  };

  return {
    id: claudeRes.id || generateId('msg'),
    output,
    usage,
  };
}
