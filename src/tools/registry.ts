import type { RegisteredTool, ToolDefinition } from '../types.js';
import { generateId } from '../utils/id-generator.js';
import { Errors } from '../utils/errors.js';

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();
  private readonly idIndex = new Map<string, string>(); // id → name

  register(tool: RegisteredTool): string {
    if (this.tools.has(tool.name)) {
      throw Errors.invalidRequest(`Tool with name "${tool.name}" already exists`);
    }

    const id = tool.id || generateId('tool');
    const registered = { ...tool, id, is_enabled: tool.is_enabled ?? true };

    this.tools.set(tool.name, registered);
    this.idIndex.set(id, tool.name);

    return id;
  }

  get(nameOrId: string): RegisteredTool | undefined {
    const byName = this.tools.get(nameOrId);
    if (byName) return byName;

    const name = this.idIndex.get(nameOrId);
    if (name) return this.tools.get(name);

    return undefined;
  }

  list(): RegisteredTool[] {
    return Array.from(this.tools.values());
  }

  update(nameOrId: string, updates: Partial<RegisteredTool>): RegisteredTool {
    const existing = this.get(nameOrId);
    if (!existing) {
      throw Errors.toolNotFound([nameOrId]);
    }

    // If name changes, re-key the map
    if (updates.name && updates.name !== existing.name) {
      if (this.tools.has(updates.name)) {
        throw Errors.invalidRequest(`Tool with name "${updates.name}" already exists`);
      }
      this.tools.delete(existing.name);
      const updated = { ...existing, ...updates };
      this.tools.set(updated.name, updated);
      this.idIndex.set(updated.id!, updated.name);
      return updated;
    }

    const updated = { ...existing, ...updates };
    this.tools.set(existing.name, updated);
    return updated;
  }

  remove(nameOrId: string): boolean {
    const existing = this.get(nameOrId);
    if (!existing) return false;

    this.tools.delete(existing.name);
    if (existing.id) this.idIndex.delete(existing.id);
    return true;
  }

  clear(): void {
    this.tools.clear();
    this.idIndex.clear();
  }

  /**
   * Resolve tool names to OpenAI function tool definitions.
   * Throws if any tool is not found.
   */
  resolveTools(names: string[]): ToolDefinition[] {
    const resolved: ToolDefinition[] = [];
    const missing: string[] = [];

    for (const name of names) {
      const tool = this.get(name);
      if (!tool || tool.is_enabled === false) {
        missing.push(name);
      } else {
        resolved.push({
          type: 'function',
          name: tool.name,
          description: tool.description,
          parameters: tool.input_schema,
        });
      }
    }

    if (missing.length > 0) {
      throw Errors.toolNotFound(missing);
    }

    return resolved;
  }
}
