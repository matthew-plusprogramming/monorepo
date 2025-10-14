import {
  LoggerService,
  type LoggerServiceSchema,
} from '@packages/backend-core';
import { Effect, Layer } from 'effect';

export type CapturedLoggerEntries = {
  readonly logs: Array<ReadonlyArray<unknown>>;
  readonly errors: Array<ReadonlyArray<unknown>>;
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
    log: (...input) =>
      Effect.sync(() => {
        entries.logs.push(input);
      }),
    logError: (...input) =>
      Effect.sync(() => {
        entries.errors.push(input);
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
