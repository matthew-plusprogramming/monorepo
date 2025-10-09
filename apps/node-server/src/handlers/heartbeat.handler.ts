import {
  EventBridgeService,
  generateRequestHandler,
  type handlerInput,
  HTTP_RESPONSE,
  InternalServerError,
  LoggerService,
} from '@packages/backend-core';
import { Effect } from 'effect';
import z from 'zod';

import { analyticsEventBusName } from '@/clients/cdkOutputs';
import { AppLayer } from '@/layers/app.layer';

const HEARTBEAT_DETAIL_TYPE = 'user.heartbeat';
const HEARTBEAT_SOURCE = 'app.node-server';
const PLATFORM_HEADER = 'x-platform';

const heartbeatHandler = (
  input: handlerInput,
): Effect.Effect<
  string,
  InternalServerError,
  EventBridgeService | LoggerService
> => {
  return Effect.gen(function* () {
    const req = yield* input;
    const eventBridge = yield* EventBridgeService;
    const logger = yield* LoggerService;

    const authenticatedUser = req.user;
    if (!authenticatedUser) {
      yield* logger.logError(
        new Error('Authenticated heartbeat missing user context'),
      );
      return yield* new InternalServerError({
        message: 'Failed to resolve authenticated user for heartbeat request',
      });
    }

    const platformHeader = req.headers[PLATFORM_HEADER];
    const platformValue = Array.isArray(platformHeader)
      ? platformHeader[0]
      : platformHeader;

    const platform = z
      .string()
      .optional()
      .catch('unknown')
      .parse(platformValue ?? req.headers['user-agent']);

    const heartbeatDetail = {
      userId: authenticatedUser.sub,
      timestamp: new Date().toISOString(),
      env: process.env.APP_ENV ?? process.env.NODE_ENV ?? 'unknown',
      appVersion:
        process.env.APP_VERSION ?? process.env.npm_package_version ?? 'unknown',
      platform,
    };

    const publishResult = yield* eventBridge
      .putEvents({
        Entries: [
          {
            EventBusName: analyticsEventBusName,
            Detail: JSON.stringify(heartbeatDetail),
            DetailType: HEARTBEAT_DETAIL_TYPE,
            Source: HEARTBEAT_SOURCE,
          },
        ],
      })
      .pipe(
        Effect.catchAll((error) =>
          Effect.gen(function* () {
            const analyticsError =
              error instanceof Error ? error : new Error(String(error));
            yield* logger.logError(analyticsError);
            return yield* Effect.fail(
              new InternalServerError({
                message: 'Failed to publish heartbeat analytics event',
              }),
            );
          }),
        ),
      );

    if ((publishResult.FailedEntryCount ?? 0) > 0) {
      const failedEntries = (publishResult.Entries ?? []).filter(
        (entry) => entry?.ErrorCode || entry?.ErrorMessage,
      );
      const failureSummary =
        failedEntries
          .map((entry, index) => {
            const errorCode = entry?.ErrorCode ?? 'UnknownError';
            const errorMessage = entry?.ErrorMessage ?? 'Unknown failure';
            return `Entry ${index}: ${errorCode} - ${errorMessage}`;
          })
          .join('; ') || 'EventBridge reported failed entries with no details';

      const failureError = new Error(
        `Heartbeat analytics publish failed (${publishResult.FailedEntryCount} entries): ${failureSummary}`,
      );
      yield* logger.logError(failureError);

      return yield* Effect.fail(
        new InternalServerError({
          message: 'Failed to publish heartbeat analytics event',
        }),
      );
    }

    yield* logger.log(
      `Heartbeat event recorded for user ${authenticatedUser.sub}`,
    );

    return 'OK';
  });
};

export const heartbeatRequestHandler = generateRequestHandler<
  string,
  InternalServerError
>({
  effectfulHandler: (input) =>
    heartbeatHandler(input).pipe(Effect.provide(AppLayer)),
  shouldObfuscate: () => true,
  statusCodesToErrors: {
    [HTTP_RESPONSE.INTERNAL_SERVER_ERROR]: {
      errorType: InternalServerError,
      mapper: (error) => error.message,
    },
  },
  successCode: HTTP_RESPONSE.SUCCESS,
});
