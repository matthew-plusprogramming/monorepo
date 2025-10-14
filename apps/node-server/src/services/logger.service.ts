import type { PutLogEventsCommandOutput } from '@aws-sdk/client-cloudwatch-logs';
import {
  LoggerService,
  type LoggerServiceSchema,
} from '@packages/backend-core';
import { Effect, Layer } from 'effect';

type ConsoleLoggerOutput = PutLogEventsCommandOutput & {
  readonly $metadata: {
    readonly httpStatusCode: number;
  };
};

const LOG_SUCCESS_METADATA = {
  $metadata: {
    httpStatusCode: 200,
  },
} as ConsoleLoggerOutput;

const ConsoleLoggerService: LoggerServiceSchema = {
  log: (input?: string): Effect.Effect<PutLogEventsCommandOutput, never> =>
    Effect.sync(() => {
      console.info(input);
      return LOG_SUCCESS_METADATA;
    }),
  logError: (input: Error): Effect.Effect<PutLogEventsCommandOutput, never> =>
    Effect.sync(() => {
      console.error('[ERROR]', input.message);
      console.error(input.stack);
      return LOG_SUCCESS_METADATA;
    }),
};

export const ApplicationLoggerService = Layer.succeed(
  LoggerService,
  ConsoleLoggerService,
);

export const SecurityLoggerService = Layer.succeed(
  LoggerService,
  ConsoleLoggerService,
);

export { LoggerService } from '@packages/backend-core';
