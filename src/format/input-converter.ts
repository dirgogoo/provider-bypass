import type { InputItem } from '../types.js';
import { generateId } from '../utils/id-generator.js';

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: any;
}

/**
 * Convert OpenAI Responses API input[] → Anthropic Messages API messages[].
 *
 * Handles:
 * - user/assistant messages (passthrough)
 * - developer/system messages → user (Claude doesn't have developer role)
 * - function_call → assistant tool_use block
 * - function_call_output → user tool_result block
 */
export function inputToMessages(input: InputItem[]): AnthropicMessage[] {
  const messages: AnthropicMessage[] = [];

  for (const item of input) {
    // Standard message
    if ('role' in item && (item.role === 'user' || item.role === 'assistant')) {
      messages.push({ role: item.role, content: item.content });
      continue;
    }

    // Developer/system → user
    if ('role' in item && (item.role === 'developer' || item.role === 'system')) {
      messages.push({ role: 'user', content: item.content });
      continue;
    }

    // function_call → assistant tool_use
    if ('type' in item && item.type === 'function_call') {
      let parsedInput: any;
      try {
        parsedInput = typeof item.arguments === 'string'
          ? JSON.parse(item.arguments)
          : item.arguments;
      } catch {
        parsedInput = {};
      }

      const toolUseBlock = {
        type: 'tool_use',
        id: item.call_id || item.id || generateId('toolu'),
        name: item.name,
        input: parsedInput,
      };

      const lastMsg = messages[messages.length - 1];
      if (lastMsg?.role === 'assistant') {
        if (Array.isArray(lastMsg.content)) {
          lastMsg.content.push(toolUseBlock);
        } else {
          lastMsg.content = [
            ...(lastMsg.content ? [{ type: 'text', text: lastMsg.content }] : []),
            toolUseBlock,
          ];
        }
      } else {
        messages.push({ role: 'assistant', content: [toolUseBlock] });
      }
      continue;
    }

    // function_call_output → user tool_result
    if ('type' in item && item.type === 'function_call_output') {
      const toolResultBlock = {
        type: 'tool_result',
        tool_use_id: item.call_id,
        content: item.output,
      };

      const lastMsg = messages[messages.length - 1];
      if (lastMsg?.role === 'user' && Array.isArray(lastMsg.content)) {
        lastMsg.content.push(toolResultBlock);
      } else {
        messages.push({ role: 'user', content: [toolResultBlock] });
      }
      continue;
    }

    // Fallback: treat as user message
    if ('content' in item && item.content) {
      const role = ('role' in item && item.role === 'assistant') ? 'assistant' : 'user';
      messages.push({ role, content: item.content });
    }
  }

  return messages;
}
