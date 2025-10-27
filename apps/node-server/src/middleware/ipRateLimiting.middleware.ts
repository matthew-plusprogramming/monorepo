import {
  type handlerInput,
  HTTP_RESPONSE,
  InternalServerError,
  RateLimitExceededError,
} from '@packages/backend-core';
import { RATE_LIMITING_SCHEMA_CONSTANTS } from '@packages/schemas/security';
import { Effect } from 'effect';
import type { RequestHandler } from 'express';

import { rateLimitTableName } from '@/clients/cdkOutputs';
import {
  DynamoDbService,
  LiveDynamoDbService,
} from '@/services/dynamodb.service';
import {
  LoggerService,
  SecurityLoggerService,
} from '@/services/logger.service';

const WINDOW_SECONDS = 60;
const RATE_LIMIT_CALLS = 5;

// TODO: refactor out to backend-core with deps
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
          cause: undefined,
        }),
      );
    }

    // Single-UpdateItem approach using a fixed 60s window bucket in the key
    const nowSec = Math.floor(Date.now() / 1000);
    const windowStart = Math.floor(nowSec / WINDOW_SECONDS) * WINDOW_SECONDS;
    const windowEndTtl = windowStart + WINDOW_SECONDS;

    const partitionKeyValue = `${
      RATE_LIMITING_SCHEMA_CONSTANTS.key.suffix.ip
    }#${ip}#${windowStart}`;

    const updated = yield* databaseService
      .updateItem({
        TableName: rateLimitTableName,
        Key: {
          [RATE_LIMITING_SCHEMA_CONSTANTS.key.base]: { S: partitionKeyValue },
        },
        UpdateExpression:
          'SET calls = if_not_exists(calls, :zero) + :one, #ttl = :ttl',
        ExpressionAttributeNames: {
          '#ttl': 'ttl',
        },
        ExpressionAttributeValues: {
          ':zero': { N: '0' },
          ':one': { N: '1' },
          ':ttl': { N: windowEndTtl.toString() },
        },
        ReturnValues: 'ALL_NEW',
      })
      .pipe(
        Effect.catchAll((error) =>
          Effect.gen(function* () {
            yield* loggerService.logError(error);
            return yield* Effect.fail(
              new InternalServerError({ message: error.message, cause: error }),
            );
          }),
        ),
      );

    // Parse the updated call count
    const callsN = updated.Attributes?.calls?.N ?? '0';
    const newNumCalls = parseInt(callsN);

    // TODO: refactor out to constants
    if (newNumCalls > RATE_LIMIT_CALLS) {
      yield* loggerService.log(
        `[RATE_LIMIT_EXCEEDED] ${ip} - ${newNumCalls} calls`,
      );
      return yield* Effect.fail(
        new RateLimitExceededError({
          message: 'Rate limit exceeded',
          cause: undefined,
        }),
      );
    }
  })
    .pipe(Effect.provide(SecurityLoggerService))
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
    .pipe(
      Effect.tap(() => {
        next();
      }),
    )
    .pipe(Effect.runPromise);
};
