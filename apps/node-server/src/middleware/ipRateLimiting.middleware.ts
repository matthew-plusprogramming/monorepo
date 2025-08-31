import {
  type handlerInput,
  HTTP_RESPONSE,
  InternalServerError,
  RateLimitExceededError,
} from '@packages/backend-core';
import { RATE_LIMITING_SCHEMA_CONSTANTS } from '@packages/schemas/security';
import { isTTLExpiredSeconds, secondsFromNowTimestamp } from '@utils/ts-utils';
import { Effect } from 'effect';
import type { RequestHandler } from 'express';

import { rateLimitTableName } from '../clients/cdkOutputs';
import {
  DynamoDbService,
  LiveDynamoDbService,
} from '../services/dynamodb.service';
import {
  ApplicationLoggerService,
  LoggerService,
} from '../services/logger.service';

const ipRateLimitingMiddlewareHandler = (
  input: handlerInput,
): Effect.Effect<void, InternalServerError | RateLimitExceededError> =>
  Effect.gen(function* () {
    const loggerService = yield* LoggerService;
    const databaseService = yield* DynamoDbService;
    const req = yield* input;

    const ip = req.ip;

    if (!ip) {
      return yield* Effect.fail(
        new RateLimitExceededError({
          message: 'IP address is required for rate limiting',
        }),
      );
    }

    const rateLimitEntry = yield* databaseService
      .getItem({
        TableName: rateLimitTableName,
        Key: {
          [RATE_LIMITING_SCHEMA_CONSTANTS.key.base]: {
            S: `${RATE_LIMITING_SCHEMA_CONSTANTS.key.suffix.ip}#${ip}`,
          },
        },
      })
      .pipe(Effect.map((res) => res.Item))
      .pipe(
        Effect.catchAll((e) => {
          loggerService.logError(e);
          return Effect.fail(new InternalServerError({ message: e.message }));
        }),
      );

    yield* loggerService.log(JSON.stringify(rateLimitEntry));

    yield* databaseService
      .putItem({
        TableName: rateLimitTableName,
        Item: {
          [RATE_LIMITING_SCHEMA_CONSTANTS.key.base]: {
            S: `${RATE_LIMITING_SCHEMA_CONSTANTS.key.suffix.ip}#${ip}`,
          },
          calls: {
            N: '1',
          },
          ttl: {
            N: secondsFromNowTimestamp(60).toString(),
          },
        },
      })
      .pipe(
        Effect.catchAll((e) => {
          loggerService.logError(e);
          return Effect.fail(new InternalServerError({ message: e.message }));
        }),
      );

    // TODO: refactor out to constants
    const RATE_LIMIT_CALLS = 5;
    let newTtl = secondsFromNowTimestamp(60).toString();
    let newNumCalls = 1;
    if (rateLimitEntry) {
      const ttl = parseInt(rateLimitEntry.ttl?.N ?? '');
      if (!isTTLExpiredSeconds(isNaN(ttl) ? 0 : ttl)) {
        // TTL has not expired, increment the rate limit
        newNumCalls = parseInt(rateLimitEntry.calls?.N ?? '0') + 1;
        newTtl = ttl.toString();
      }
    }

    yield* databaseService
      .putItem({
        TableName: rateLimitTableName,
        Item: {
          [RATE_LIMITING_SCHEMA_CONSTANTS.key.base]: {
            S: `${RATE_LIMITING_SCHEMA_CONSTANTS.key.suffix.ip}#${ip}`,
          },
          calls: {
            N: newNumCalls.toString(),
          },
          ttl: {
            N: newTtl,
          },
        },
      })
      .pipe(
        Effect.catchAll((e) => {
          loggerService.logError(e);
          return Effect.fail(new InternalServerError({ message: e.message }));
        }),
      );

    if (newNumCalls > RATE_LIMIT_CALLS) {
      return yield* Effect.fail(
        new RateLimitExceededError({
          message: 'Rate limit exceeded',
        }),
      );
    }
  })
    .pipe(Effect.provide(ApplicationLoggerService))
    .pipe(Effect.provide(LiveDynamoDbService));

// TODO: Refactor to middleware request handler (make in backend-core)
export const ipRateLimitingMiddlewareRequestHandler: RequestHandler = async (
  req,
  res,
  next,
) => {
  await Effect.succeed(req)
    .pipe(ipRateLimitingMiddlewareHandler)
    .pipe(
      Effect.catchTag('RateLimitExceededError', () =>
        Effect.fail(res.status(HTTP_RESPONSE.THROTTLED).send()),
      ),
    )
    .pipe(Effect.tap(() => next()))
    .pipe(Effect.runPromise);
};
