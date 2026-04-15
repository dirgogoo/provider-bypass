import type { Logger } from '../types.js';

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;

function getLogLevel(): number {
  const env = process.env.BYPASS_LOG_LEVEL?.toLowerCase();
  if (env && env in LOG_LEVELS) return LOG_LEVELS[env as keyof typeof LOG_LEVELS];
  return LOG_LEVELS.info;
}

export function createDefaultLogger(): Logger {
  const level = getLogLevel();

  return {
    debug(msg, ...args) {
      if (level <= LOG_LEVELS.debug) console.debug(`[provider-bypass] ${msg}`, ...args);
    },
    info(msg, ...args) {
      if (level <= LOG_LEVELS.info) console.log(`[provider-bypass] ${msg}`, ...args);
    },
    warn(msg, ...args) {
      if (level <= LOG_LEVELS.warn) console.warn(`[provider-bypass] ${msg}`, ...args);
    },
    error(msg, ...args) {
      if (level <= LOG_LEVELS.error) console.error(`[provider-bypass] ${msg}`, ...args);
    },
  };
}
