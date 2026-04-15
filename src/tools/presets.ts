import type { PresetInput, Preset, RegisteredTool, ToolDefinition } from '../types.js';
import type { ToolRegistry } from './registry.js';
import { generateId } from '../utils/id-generator.js';
import { Errors } from '../utils/errors.js';

export class PresetRegistry {
  private readonly presets = new Map<string, Preset>();
  private readonly idIndex = new Map<string, string>(); // id → name
  private readonly toolRegistry: ToolRegistry;

  constructor(toolRegistry: ToolRegistry) {
    this.toolRegistry = toolRegistry;
  }

  create(input: PresetInput): string {
    if (this.presets.has(input.name)) {
      throw Errors.invalidRequest(`Preset with name "${input.name}" already exists`);
    }

    const id = generateId('preset');
    const preset: Preset = { ...input, id };

    this.presets.set(input.name, preset);
    this.idIndex.set(id, input.name);

    return id;
  }

  get(nameOrId: string): Preset | undefined {
    const byName = this.presets.get(nameOrId);
    if (byName) return byName;

    const name = this.idIndex.get(nameOrId);
    if (name) return this.presets.get(name);

    return undefined;
  }

  list(): Preset[] {
    return Array.from(this.presets.values());
  }

  remove(nameOrId: string): boolean {
    const existing = this.get(nameOrId);
    if (!existing) return false;

    this.presets.delete(existing.name);
    this.idIndex.delete(existing.id);
    return true;
  }

  /**
   * Resolve a preset to its tool definitions via the tool registry.
   */
  getTools(nameOrId: string): ToolDefinition[] {
    const preset = this.get(nameOrId);
    if (!preset) {
      throw Errors.presetNotFound(nameOrId);
    }

    return this.toolRegistry.resolveTools(preset.tool_names);
  }

  clear(): void {
    this.presets.clear();
    this.idIndex.clear();
  }
}
