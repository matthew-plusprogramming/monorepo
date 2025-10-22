import type {
  PutEventsCommandInput,
  PutEventsCommandOutput,
} from '@aws-sdk/client-eventbridge';
import { Effect, Layer } from 'effect';

import {
  EventBridgeService,
  type EventBridgeServiceSchema,
} from '@/services/event-bridge.js';

type ResponseEntry =
  | { type: 'success'; value: PutEventsCommandOutput }
  | { type: 'error'; error: Error };

export type EventBridgeServiceFake = {
  readonly service: EventBridgeServiceSchema;
  readonly layer: Layer.Layer<EventBridgeService, never, never>;
  readonly queueSuccess: (output: PutEventsCommandOutput) => void;
  readonly queueFailure: (error: Error) => void;
  readonly calls: Array<PutEventsCommandInput>;
  readonly reset: () => void;
};

const createDefaultOutputError = (): Error =>
  new Error('No response queued for EventBridgeService.putEvents');

export const createEventBridgeServiceFake = (): EventBridgeServiceFake => {
  const responseQueue: Array<ResponseEntry> = [];
  const callHistory: Array<PutEventsCommandInput> = [];

  const service: EventBridgeServiceSchema = {
    putEvents: (input: PutEventsCommandInput) =>
      Effect.sync(() => {
        callHistory.push(input);
      }).pipe(
        Effect.flatMap(() => {
          const next = responseQueue.shift();
          if (!next) {
            return Effect.fail(createDefaultOutputError());
          }

          if (next.type === 'success') {
            return Effect.succeed(next.value);
          }

          return Effect.fail(next.error);
        }),
      ),
  };

  return {
    service,
    layer: Layer.succeed(EventBridgeService, service),
    queueSuccess: (output): void => {
      responseQueue.push({ type: 'success', value: output });
    },
    queueFailure: (error): void => {
      responseQueue.push({ type: 'error', error });
    },
    calls: callHistory,
    reset: (): void => {
      responseQueue.length = 0;
      callHistory.length = 0;
    },
  };
};
