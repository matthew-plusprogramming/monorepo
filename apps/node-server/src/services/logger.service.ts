import {
  LoggerService,
  type LoggerServiceSchema,
} from '@packages/backend-core';
import { Effect, Layer } from 'effect';

const ConsoleLoggerService: LoggerServiceSchema = {
  log: (...input: ReadonlyArray<unknown>): Effect.Effect<void, never> =>
    Effect.sync(() => {
      console.info(...input);
    }),
  logError: (...input: ReadonlyArray<unknown>): Effect.Effect<void, never> =>
    Effect.sync(() => {
      console.error(...input);
    }),
  logDebug: (...input: ReadonlyArray<unknown>): Effect.Effect<void, never> =>
    Effect.sync(() => {
      if (process.env.DEBUG?.toLowerCase() === 'true') {
        console.info(...input);
      }
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
