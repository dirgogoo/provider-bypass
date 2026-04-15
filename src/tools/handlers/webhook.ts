import type { WebhookHandlerConfig } from './types.js';
import { Errors } from '../../utils/errors.js';

export async function executeWebhook(
  config: WebhookHandlerConfig,
  input: Record<string, any>,
): Promise<any> {
  try {
    const res = await fetch(config.url, {
      method: config.method || 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...config.headers,
      },
      body: JSON.stringify(input),
    });

    if (!res.ok) {
      throw new Error(`Webhook returned ${res.status}: ${await res.text()}`);
    }

    return await res.json();
  } catch (err) {
    throw Errors.handlerError(`Webhook handler failed: ${(err as Error).message}`, err);
  }
}
