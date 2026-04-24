import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

const DIR = join(homedir(), '.provider-bypass');
const FILE = join(DIR, 'installation-id');

let cached: string | null = null;

/**
 * Persistent per-machine installation UUID.
 *
 * Required for the Codex WebSocket handshake (`x-codex-installation-id` in
 * client_metadata). Mirrors the behavior of the Codex CLI, which generates a
 * UUID once per install and reuses it forever. Persisted at
 * ~/.provider-bypass/installation-id.
 *
 * Cached in memory after first read.
 */
export function getInstallationId(): string {
  if (cached) return cached;

  try {
    if (existsSync(FILE)) {
      const value = readFileSync(FILE, 'utf-8').trim();
      if (value) {
        cached = value;
        return cached;
      }
    }
  } catch {
    // fall through to regenerate
  }

  const id = randomUUID();
  try {
    if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
    writeFileSync(FILE, id, { mode: 0o600 });
  } catch {
    // non-fatal: caller still gets a valid UUID, just not persisted
  }
  cached = id;
  return cached;
}
