import type { PutLogEventsCommandOutput } from '@aws-sdk/client-cloudwatch-logs';
import { Context, type Effect } from 'effect';

export type LoggerServiceSchema = {
  readonly log: (
    input?: string,
  ) => Effect.Effect<PutLogEventsCommandOutput, never>;

  readonly logError: (
    input: Error,
  ) => Effect.Effect<PutLogEventsCommandOutput, never>;
};

export class LoggerService extends Context.Tag('LoggerService')<
  LoggerService,
  LoggerServiceSchema
>() {}
