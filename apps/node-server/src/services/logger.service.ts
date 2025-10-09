import { Agent } from 'node:https';

import {
  type __MetadataBearer,
  CloudWatchLogsClient,
  PutLogEventsCommand,
  type PutLogEventsCommandOutput,
} from '@aws-sdk/client-cloudwatch-logs';
import {
  LoggerService,
  type LoggerServiceSchema,
} from '@packages/backend-core';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { Effect, Layer } from 'effect';

import {
  applicationLogGroupName,
  securityLogGroupName,
  securityLogStreamName,
  serverLogStreamName,
} from '@/clients/cdkOutputs';

const LOG_FAILED_METADATA = {
  $metadata: {
    httpStatusCode: 500,
  },
} satisfies __MetadataBearer;

const LOG_SUCCESS_METADATA = {
  $metadata: {
    httpStatusCode: 200,
  },
} satisfies __MetadataBearer;

// TODO: move to constants
const httpHandler = new NodeHttpHandler({
  connectionTimeout: 300,
  socketTimeout: 1000,
  requestTimeout: 1500,
  httpsAgent: new Agent({ keepAlive: true }),
});

// TODO: Implement context (ip, userId, tokenId) for logging that can be passed
const makeLoggerService = (
  logGroupName: string,
  logStreamName: string,
): Effect.Effect<LoggerServiceSchema, never, never> =>
  Effect.sync(() => {
    const client = new CloudWatchLogsClient({
      region: process.env.AWS_REGION,
      requestHandler: httpHandler,
      maxAttempts: 2,
    });

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

const ConsoleLoggerService = {
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

const shouldUseConsoleLogger = __BUNDLED__ || process.env.NODE_ENV === 'test';

export const ApplicationLoggerService = shouldUseConsoleLogger
  ? Layer.succeed(LoggerService, ConsoleLoggerService)
  : Layer.effect(
      LoggerService,
      makeLoggerService(applicationLogGroupName, serverLogStreamName),
    );

export const SecurityLoggerService = shouldUseConsoleLogger
  ? Layer.succeed(LoggerService, ConsoleLoggerService)
  : Layer.effect(
      LoggerService,
      makeLoggerService(securityLogGroupName, securityLogStreamName),
    );

export { LoggerService } from '@packages/backend-core';
