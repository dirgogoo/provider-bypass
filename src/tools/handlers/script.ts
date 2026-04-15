import { execFileSync } from 'node:child_process';
import type { ScriptHandlerConfig } from './types.js';
import { Errors } from '../../utils/errors.js';

export function executeScript(
  config: ScriptHandlerConfig,
  input: Record<string, any>,
): string {
  try {
    const args = config.args
      ? config.args.map((a) => a.replace(/\{\{(\w+)\}\}/g, (_, key) => String(input[key] ?? '')))
      : [];

    const output = execFileSync(config.command, args, {
      timeout: config.timeout || 30000,
      cwd: config.cwd || process.cwd(),
      stdio: 'pipe',
    });

    return output.toString('utf-8');
  } catch (err) {
    throw Errors.handlerError(`Script handler failed: ${(err as Error).message}`, err);
  }
}
