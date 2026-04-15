import type { StreamEvent, SendResponse } from '../types.js';
import { generateId } from '../utils/id-generator.js';
import { claudeResponseToOpenAI } from './output-converter.js';

/**
 * Adapts Claude SSE stream events into OpenAI Responses API StreamEvent objects.
 *
 * Handles:
 * - message_start → response.created
 * - content_block_start → response.output_item.added + response.content_part.added
 * - content_block_delta → response.output_text.delta / response.function_call_arguments.delta
 * - content_block_stop → response.output_item.done
 * - message_stop → response.completed
 */
export function createClaudeStreamAdapter(onEvent: (event: StreamEvent) => void) {
  let responseId = generateId('msg');
  let currentBlockIndex = 0;
  const blockIdMap = new Map<number, string>();

  return {
    /**
     * Process a raw SSE line from the Claude API stream.
     */
    onRawEvent(rawEvent: string) {
      const dataMatch = rawEvent.match(/data: (.+)/);
      if (!dataMatch) return;

      try {
        const event = JSON.parse(dataMatch[1]);

        // message_start → response.created
        if (event.type === 'message_start' && event.message) {
          responseId = event.message.id || responseId;
          onEvent({
            type: 'response.created',
            response: {
              id: responseId,
              object: 'response',
              model: event.message.model,
              status: 'in_progress',
              output: [],
            } as any,
          });
          return;
        }

        // content_block_start → response.output_item.added
        if (event.type === 'content_block_start') {
          const block = event.content_block;
          const itemId = generateId('msg');
          blockIdMap.set(event.index, itemId);

          if (block?.type === 'text') {
            onEvent({
              type: 'response.output_item.added',
              item: {
                id: itemId,
                type: 'message',
                status: 'in_progress',
                content: [],
                role: 'assistant',
              },
              output_index: currentBlockIndex,
            });

            onEvent({
              type: 'response.content_part.added',
              part: { type: 'output_text', text: '' },
              content_index: 0,
              item_id: itemId,
              output_index: currentBlockIndex,
            });
          }

          if (block?.type === 'tool_use') {
            onEvent({
              type: 'response.output_item.added',
              item: {
                id: block.id || itemId,
                type: 'function_call',
                status: 'in_progress',
                name: block.name,
                arguments: '',
                call_id: block.id || itemId,
              },
              output_index: currentBlockIndex,
            });
          }
          return;
        }

        // content_block_delta → text delta / function call args delta
        if (event.type === 'content_block_delta') {
          const itemId = blockIdMap.get(event.index) || '';

          if (event.delta?.type === 'text_delta') {
            onEvent({
              type: 'response.output_text.delta',
              content_index: 0,
              delta: event.delta.text,
              item_id: itemId,
              output_index: currentBlockIndex,
            });
          }

          if (event.delta?.type === 'input_json_delta') {
            onEvent({
              type: 'response.function_call_arguments.delta',
              delta: event.delta.partial_json,
              item_id: itemId,
              output_index: currentBlockIndex,
            });
          }

          if (event.delta?.type === 'thinking_delta') {
            onEvent({
              type: 'response.output_text.delta',
              content_index: 0,
              delta: event.delta.thinking,
              item_id: itemId,
              output_index: currentBlockIndex,
            });
          }
          return;
        }

        // content_block_stop → response.output_item.done
        if (event.type === 'content_block_stop') {
          const itemId = blockIdMap.get(event.index) || '';
          onEvent({
            type: 'response.output_item.done',
            item: { id: itemId, status: 'completed' } as any,
            output_index: currentBlockIndex,
          });
          currentBlockIndex++;
          return;
        }

      } catch {
        // Skip unparseable
      }
    },

    /**
     * Send the final response.completed event.
     */
    sendCompleted(claudeResponse: any, model: string, latencyMs: number) {
      const { output, usage, id } = claudeResponseToOpenAI(claudeResponse, model, latencyMs);
      onEvent({
        type: 'response.completed',
        response: {
          id,
          object: 'response',
          model,
          output,
          status: 'completed',
          usage,
          latencyMs,
          provider: 'claude',
        },
      });
    },
  };
}

/**
 * Parse a raw Codex SSE event line into a StreamEvent object.
 */
export function parseCodexStreamEvent(rawEvent: string): StreamEvent | null {
  const dataMatch = rawEvent.match(/data: (.+)/);
  if (!dataMatch) return null;

  const data = dataMatch[1].trim();
  if (data === '[DONE]') return null;

  try {
    const event = JSON.parse(data);
    // Codex events are already in OpenAI Responses API format
    return event as StreamEvent;
  } catch {
    return null;
  }
}
