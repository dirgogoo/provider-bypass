import type { RestHandlerConfig } from './types.js';
import { Errors } from '../../utils/errors.js';

export async function executeRest(
  config: RestHandlerConfig,
  input: Record<string, any>,
): Promise<any> {
  try {
    let body: string | undefined;
    if (config.body_template) {
      body = config.body_template.replace(
        /\{\{(\w+)\}\}/g,
        (_, key) => JSON.stringify(input[key] ?? ''),
      );
    } else {
      body = JSON.stringify(input);
    }

    const res = await fetch(config.url, {
      method: config.method,
      headers: {
        'Content-Type': 'application/json',
        ...config.headers,
      },
      body: config.method !== 'GET' ? body : undefined,
    });

    if (!res.ok) {
      throw new Error(`REST handler returned ${res.status}: ${await res.text()}`);
    }

    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      return await res.json();
    }
    return await res.text();
  } catch (err) {
    throw Errors.handlerError(`REST handler failed: ${(err as Error).message}`, err);
  }
}
