import type { PutLogEventsCommandOutput } from '@aws-sdk/client-cloudwatch-logs';
import {
  LoggerService,
  type LoggerServiceSchema,
} from '@packages/backend-core';
import { Effect, Layer } from 'effect';

const LOG_SUCCESS_METADATA = {
  $metadata: {
    httpStatusCode: 200,
  },
} as PutLogEventsCommandOutput;

export type CapturedLoggerEntries = {
  readonly logs: Array<string | undefined>;
  readonly errors: Array<Error>;
};

export type LoggerServiceFake = {
  readonly service: LoggerServiceSchema;
  readonly layer: Layer.Layer<never, never, LoggerService>;
  readonly entries: CapturedLoggerEntries;
  readonly reset: () => void;
};

export const createLoggerServiceFake = (): LoggerServiceFake => {
  const entries: CapturedLoggerEntries = {
    logs: [],
    errors: [],
  };

  const service: LoggerServiceSchema = {
    log: (input) =>
      Effect.sync(() => {
        entries.logs.push(input);
        return LOG_SUCCESS_METADATA;
      }),
    logError: (input) =>
      Effect.sync(() => {
        entries.errors.push(input);
        return LOG_SUCCESS_METADATA;
      }),
  };

  return {
    service,
    layer: Layer.succeed(LoggerService, service),
    entries,
    reset: (): void => {
      entries.logs.length = 0;
      entries.errors.length = 0;
    },
  };
};
