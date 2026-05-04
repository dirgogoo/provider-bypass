import { readFileSync, existsSync, watchFile, unwatchFile } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { OAuthCredentials, AuthConfig } from './types.js';
import type { Logger } from '../types.js';
import { Errors } from '../utils/errors.js';

const DEFAULT_CRED_PATH = join(homedir(), '.claude', '.credentials.json');
const DEFAULT_REFRESH_CMD = 'claude --version';
const BUFFER_MS = 5 * 60 * 1000; // 5 min buffer before expiry
const CLAUDE_CODE_VERSION = '2.1.123';
const DEFAULT_USER_AGENT = `claude-cli/${CLAUDE_CODE_VERSION} (external, sdk-cli)`;
const ANTHROPIC_BETA = [
  'claude-code-20250219',
  'oauth-2025-04-20',
  'interleaved-thinking-2025-05-14',
  'context-management-2025-06-27',
  'prompt-caching-scope-2026-01-05',
  'effort-2025-11-24',
].join(',');

export class ClaudeAuth {
  private readonly credPath: string;
  private readonly refreshCmd: string;
  private readonly sessionId: string;
  private readonly userAgent: string;
  private readonly logger: Logger;
  private cached: OAuthCredentials | null = null;
  private watching = false;

  constructor(config: AuthConfig | undefined, logger: Logger) {
    this.credPath = config?.credentialPath || DEFAULT_CRED_PATH;
    this.refreshCmd = config?.refreshCommand || DEFAULT_REFRESH_CMD;
    this.sessionId = config?.sessionId || randomUUID();
    this.userAgent = config?.userAgent || DEFAULT_USER_AGENT;
    this.logger = logger;
  }

  private readCredentials(): OAuthCredentials {
    if (!existsSync(this.credPath)) {
      throw Errors.credentialsNotFound(
        'Claude — credentials not found at ' + this.credPath +
        '. Please run "claude" and log in first',
      );
    }

    const raw = JSON.parse(readFileSync(this.credPath, 'utf-8'));
    const oauth = raw.claudeAiOauth;

    if (!oauth?.accessToken) {
      throw Errors.credentialsNotFound('Claude — no OAuth access token found in credentials file');
    }

    return {
      accessToken: oauth.accessToken,
      refreshToken: oauth.refreshToken,
      expiresAt: oauth.expiresAt,
      scopes: oauth.scopes || [],
      subscriptionType: oauth.subscriptionType || '',
    };
  }

  private startWatching(): void {
    if (this.watching) return;
    this.watching = true;

    watchFile(this.credPath, { interval: 5000 }, () => {
      this.logger.debug('Claude credentials file changed, reloading token...');
      this.cached = null;
    });
  }

  private triggerRefresh(): void {
    this.logger.info('Claude token expired, triggering refresh...');
    try {
      execSync(this.refreshCmd, { timeout: 15000, stdio: 'pipe' });
      this.cached = null;
    } catch (err) {
      throw Errors.refreshFailed('Claude', err);
    }
  }

  getCredentials(): OAuthCredentials {
    this.startWatching();

    if (this.cached && this.cached.expiresAt > Date.now() + BUFFER_MS) {
      return this.cached;
    }

    this.cached = this.readCredentials();

    if (this.cached.expiresAt < Date.now() + BUFFER_MS) {
      this.triggerRefresh();
      this.cached = this.readCredentials();

      if (this.cached.expiresAt < Date.now()) {
        throw Errors.tokenExpired('Claude');
      }
    }

    this.logger.debug(
      `Claude token valid for ${Math.round((this.cached.expiresAt - Date.now()) / 60000)}min` +
      ` (${this.cached.subscriptionType})`,
    );

    return this.cached;
  }

  getHeaders(): Record<string, string> {
    const creds = this.getCredentials();

    return {
      'accept': 'application/json',
      'Authorization': `Bearer ${creds.accessToken}`,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': ANTHROPIC_BETA,
      'anthropic-dangerous-direct-browser-access': 'true',
      'x-app': 'cli',
      'x-claude-code-session-id': this.sessionId,
      'x-stainless-arch': process.arch,
      'x-stainless-lang': 'js',
      'x-stainless-os': process.platform === 'linux' ? 'Linux' : process.platform,
      'x-stainless-package-version': '0.81.0',
      'x-stainless-retry-count': '0',
      'x-stainless-runtime': 'node',
      'x-stainless-runtime-version': process.version,
      'x-stainless-timeout': '600',
      'user-agent': this.userAgent,
      'content-type': 'application/json',
    };
  }

  getTokenInfo(): { valid: boolean; expiresIn: number; subscriptionType: string } {
    try {
      const creds = this.getCredentials();
      return {
        valid: true,
        expiresIn: Math.round((creds.expiresAt - Date.now()) / 1000),
        subscriptionType: creds.subscriptionType,
      };
    } catch {
      return { valid: false, expiresIn: 0, subscriptionType: '' };
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
