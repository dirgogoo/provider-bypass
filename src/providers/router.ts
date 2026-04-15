/**
 * Determines the provider based on model name prefix.
 *
 * - claude-* → Claude (Anthropic)
 * - gpt-*, o1-*, o3-*, o4-* → Codex (OpenAI)
 */
export function isClaudeModel(model: string): boolean {
  return model.startsWith('claude-');
}
