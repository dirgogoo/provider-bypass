import { readFileSync, existsSync, watchFile, unwatchFile } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import type { CodexCredentials, AuthConfig } from './types.js';
import type { Logger } from '../types.js';
import { Errors } from '../utils/errors.js';

const DEFAULT_CRED_PATH = join(homedir(), '.codex', 'auth.json');
const DEFAULT_REFRESH_CMD = 'codex exec --quiet "respond with just ok"';
const BUFFER_MS = 5 * 60 * 1000;

/**
 * Decode JWT payload to extract expiry. No verification needed — local file.
 */
function decodeJwtExpiry(token: string): number {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return 0;
    const payload = JSON.parse(
      Buffer.from(parts[1], 'base64url').toString('utf-8'),
    );
    return (payload.exp || 0) * 1000;
  } catch {
    return 0;
  }
}

export class CodexAuth {
  private readonly credPath: string;
  private readonly refreshCmd: string;
  private readonly logger: Logger;
  private cached: CodexCredentials | null = null;
  private watching = false;

  constructor(config: AuthConfig | undefined, logger: Logger) {
    this.credPath = config?.credentialPath || DEFAULT_CRED_PATH;
    this.refreshCmd = config?.refreshCommand || DEFAULT_REFRESH_CMD;
    this.logger = logger;
  }

  private readCredentials(): CodexCredentials {
    if (!existsSync(this.credPath)) {
      throw Errors.credentialsNotFound(
        'Codex — credentials not found at ' + this.credPath +
        '. Please run "codex" and log in first',
      );
    }

    const raw = JSON.parse(readFileSync(this.credPath, 'utf-8'));
    const tokens = raw.tokens;

    if (!tokens?.access_token) {
      throw Errors.credentialsNotFound('Codex — no access token found in credentials file');
    }

    return {
      authMode: raw.auth_mode || 'chatgpt',
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      accountId: tokens.account_id,
      expiresAt: decodeJwtExpiry(tokens.access_token),
    };
  }

  private startWatching(): void {
    if (this.watching) return;
    this.watching = true;

    watchFile(this.credPath, { interval: 5000 }, () => {
      this.logger.debug('Codex credentials file changed, reloading token...');
      this.cached = null;
    });
  }

  private triggerRefresh(): void {
    this.logger.info('Codex token expired, triggering refresh...');
    try {
      execSync(this.refreshCmd, { timeout: 30000, stdio: 'pipe', cwd: '/tmp' });
      this.cached = null;
    } catch (err) {
      // Even if exec fails, the auth refresh may have succeeded
      this.cached = null;
      const freshCreds = this.readCredentials();
      if (freshCreds.expiresAt > Date.now()) {
        this.logger.debug('Codex token refreshed despite exec error.');
        return;
      }
      throw Errors.refreshFailed('Codex', err);
    }
  }

  getCredentials(): CodexCredentials {
    this.startWatching();

    if (this.cached && this.cached.expiresAt > Date.now() + BUFFER_MS) {
      return this.cached;
    }

    this.cached = this.readCredentials();

    if (this.cached.expiresAt < Date.now() + BUFFER_MS) {
      this.triggerRefresh();
      this.cached = this.readCredentials();

      if (this.cached.expiresAt < Date.now()) {
        throw Errors.tokenExpired('Codex');
      }
    }

    this.logger.debug(
      `Codex token valid for ${Math.round((this.cached.expiresAt - Date.now()) / 60000)}min` +
      ` (mode: ${this.cached.authMode})`,
    );

    return this.cached;
  }

  getHeaders(): Record<string, string> {
    const creds = this.getCredentials();

    return {
      'Authorization': `Bearer ${creds.accessToken}`,
      'Content-Type': 'application/json',
      'User-Agent': 'codex-cli/0.106.0',
    };
  }

  getTokenInfo(): { valid: boolean; expiresIn: number; authMode: string } {
    try {
      const creds = this.getCredentials();
      return {
        valid: true,
        expiresIn: Math.round((creds.expiresAt - Date.now()) / 1000),
        authMode: creds.authMode,
      };
    } catch {
      return { valid: false, expiresIn: 0, authMode: '' };
    }
  }

  destroy(): void {
    if (this.watching) {
      unwatchFile(this.credPath);
      this.watching = false;
    }
    this.cached = null;
  }
}
