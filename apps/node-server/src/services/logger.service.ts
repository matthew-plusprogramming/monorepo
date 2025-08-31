import {
  type __MetadataBearer,
  CloudWatchLogsClient,
  PutLogEventsCommand,
  type PutLogEventsCommandOutput,
} from '@aws-sdk/client-cloudwatch-logs';
import { Context, Effect, Layer } from 'effect';

import {
  applicationLogGroupName,
  serverLogStreamName,
} from '@/clients/cdkOutputs';

type LoggerServiceSchema = {
  readonly log: (
    input?: string,
  ) => Effect.Effect<PutLogEventsCommandOutput, never>;

  readonly logError: (
    input: Error,
  ) => Effect.Effect<PutLogEventsCommandOutput, never>;
};

const client = new CloudWatchLogsClient();

const LOG_FAILED_METADATA = {
  $metadata: {
    httpStatusCode: 500,
  },
} satisfies __MetadataBearer;

// TODO: Implement context (ip, userId, tokenId) for logging that can be passed
const makeLoggerService = (
  logGroupName: string,
  logStreamName: string,
): Effect.Effect<LoggerServiceSchema, never, never> =>
  Effect.sync(() => {
    const service = {
      log: (input): Effect.Effect<PutLogEventsCommandOutput, never> =>
        Effect.gen(function* () {
          const res = yield* Effect.tryPromise({
            try: () => {
              const command = new PutLogEventsCommand({
                logGroupName,
                logStreamName,
                logEvents: [{ timestamp: Date.now(), message: input }],
              });
              return client.send(command);
            },
            catch: (error) => {
              // Fall back to console
              console.error('[ERROR] Failed to put cloudwatch logs:');
              console.error(error);
            },
          }).pipe(Effect.catchAll(() => Effect.succeed(LOG_FAILED_METADATA)));

          return res;
        }),
      logError: (input): Effect.Effect<PutLogEventsCommandOutput, never> =>
        Effect.gen(function* () {
          yield* service.log(`[ERROR] ${input.message}`);
          return yield* service.log(input.stack);
        }),
    } satisfies LoggerServiceSchema;

    return service;
  });

export class LoggerService extends Context.Tag('LoggerService')<
  LoggerService,
  LoggerServiceSchema
>() {}

export const ApplicationLoggerService = Layer.effect(
  LoggerService,
  makeLoggerService(applicationLogGroupName, serverLogStreamName),
);
