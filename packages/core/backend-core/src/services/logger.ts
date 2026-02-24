import { Context, type Effect } from 'effect';

export type LoggerServiceSchema = {
  readonly log: (
    ...input: ReadonlyArray<unknown>
  ) => Effect.Effect<void, never>;

  readonly logError: (
    ...input: ReadonlyArray<unknown>
  ) => Effect.Effect<void, never>;

  readonly logDebug: (
    ...input: ReadonlyArray<unknown>
  ) => Effect.Effect<void, never>;

  readonly logWarn: (
    ...input: ReadonlyArray<unknown>
  ) => Effect.Effect<void, never>;
};

export class LoggerService extends Context.Tag('LoggerService')<
  LoggerService,
  LoggerServiceSchema
>() {}
