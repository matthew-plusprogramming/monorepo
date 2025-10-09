import { Agent } from 'node:https';

import {
  EventBridgeClient,
  PutEventsCommand,
  type PutEventsCommandInput,
} from '@aws-sdk/client-eventbridge';
import {
  EventBridgeService,
  type EventBridgeServiceSchema,
} from '@packages/backend-core';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { Effect, Layer } from 'effect';

const httpHandler = new NodeHttpHandler({
  connectionTimeout: 300,
  socketTimeout: 1000,
  requestTimeout: 1500,
  httpsAgent: new Agent({ keepAlive: true }),
});

const makeEventBridgeService = (): Effect.Effect<
  EventBridgeServiceSchema,
  never,
  never
> =>
  Effect.sync(() => {
    const client = new EventBridgeClient({
      region: process.env.AWS_REGION,
      requestHandler: httpHandler,
      maxAttempts: 2,
    });

    const service: EventBridgeServiceSchema = {
      putEvents: (input: PutEventsCommandInput) =>
        Effect.tryPromise({
          try: () => client.send(new PutEventsCommand(input)),
          catch: (error) =>
            error instanceof Error ? error : new Error(String(error)),
        }),
    };

    return service;
  });

export const LiveEventBridgeService = Layer.effect(
  EventBridgeService,
  makeEventBridgeService(),
);

export { EventBridgeService } from '@packages/backend-core';
