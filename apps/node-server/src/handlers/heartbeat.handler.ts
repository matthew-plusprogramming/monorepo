import type { PutEventsCommandOutput } from '@aws-sdk/client-eventbridge';
import {
  EventBridgeService,
  type EventBridgeServiceSchema,
  generateRequestHandler,
  type handlerInput,
  HTTP_RESPONSE,
  InternalServerError,
  LoggerService,
  type LoggerServiceSchema,
} from '@packages/backend-core';
import { exists } from '@utils/ts-utils';
import { Effect } from 'effect';
import type { Request } from 'express';
import z from 'zod';

import { analyticsEventBusName } from '@/clients/cdkOutputs';
import { AppLayer } from '@/layers/app.layer';

const HEARTBEAT_DETAIL_TYPE = 'user.heartbeat';
const HEARTBEAT_SOURCE = 'app.node-server';
const PLATFORM_HEADER = 'x-platform';

type HeartbeatDetail = {
  readonly userId: string;
  readonly timestamp: string;
  readonly env: string;
  readonly appVersion: string;
  readonly platform: string;
};

const resolvePlatform = (req: Request): string => {
  const platformValue = req.get(PLATFORM_HEADER);
  const userAgentValue = req.get('user-agent');

  return z
    .string()
    .catch('unknown')
    .parse(platformValue ?? userAgentValue);
};

const buildHeartbeatDetail = (
  user: { readonly sub: string },
  platform: string,
): HeartbeatDetail => ({
  userId: user.sub,
  timestamp: new Date().toISOString(),
  env: process.env.APP_ENV ?? process.env.NODE_ENV ?? 'unknown',
  appVersion:
    process.env.APP_VERSION ?? process.env.npm_package_version ?? 'unknown',
  platform,
});

const publishHeartbeatEvent = (
  eventBridge: EventBridgeServiceSchema,
  detail: HeartbeatDetail,
  logger: LoggerServiceSchema,
): Effect.Effect<PutEventsCommandOutput, InternalServerError> =>
  eventBridge
    .putEvents({
      Entries: [
        {
          EventBusName: analyticsEventBusName,
          Detail: JSON.stringify(detail),
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
              cause: analyticsError,
            }),
          );
        }),
      ),
    );

const summarizeFailedEntries = (result: PutEventsCommandOutput): string => {
  const entriesWithErrors = (result.Entries ?? []).filter(
    (entry) => entry?.ErrorCode || entry?.ErrorMessage,
  );
  if (entriesWithErrors.length === 0) {
    return 'EventBridge reported failed entries with no details';
  }
  return entriesWithErrors
    .map((entry, index) => {
      const errorCode = entry?.ErrorCode ?? 'UnknownError';
      const errorMessage = entry?.ErrorMessage ?? 'Unknown failure';
      return `Entry ${index}: ${errorCode} - ${errorMessage}`;
    })
    .join('; ');
};

const ensureSuccessfulPublish = (
  result: PutEventsCommandOutput,
  logger: LoggerServiceSchema,
): Effect.Effect<void, InternalServerError> =>
  Effect.gen(function* () {
    const failedCount = result.FailedEntryCount ?? 0;
    if (failedCount === 0) {
      return undefined;
    }

    const failureSummary = summarizeFailedEntries(result);
    const failureError = new Error(
      `Heartbeat analytics publish failed (${failedCount} entries): ${failureSummary}`,
    );
    yield* logger.logError(failureError);

    return yield* Effect.fail(
      new InternalServerError({
        message: 'Failed to publish heartbeat analytics event',
        cause: failureError,
      }),
    );
  });

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
        cause: null,
      });
    }

    const platform = resolvePlatform(req);
    const heartbeatDetail = buildHeartbeatDetail(authenticatedUser, platform);

    const publishResult = yield* publishHeartbeatEvent(
      eventBridge,
      heartbeatDetail,
      logger,
    );

    yield* ensureSuccessfulPublish(publishResult, logger);

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
  shouldObfuscate: (req) => !exists(req?.user),
  statusCodesToErrors: {
    [HTTP_RESPONSE.INTERNAL_SERVER_ERROR]: {
      errorType: InternalServerError,
      mapper: (error) => error.message,
    },
  },
  successCode: HTTP_RESPONSE.OK,
});
