/**
 * Webhook Service
 *
 * Provides the live implementation of the WebhookService for Effect DI.
 */

import {
  createWebhookService,
  WebhookService,
} from '@packages/backend-core/agent-tasks';
import { Layer } from 'effect';

/**
 * Live implementation of the WebhookService.
 */
export const LiveWebhookService = Layer.succeed(
  WebhookService,
  createWebhookService(),
);
