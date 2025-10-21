import { Agent } from 'node:https';

import {
  DynamoDBClient,
  GetItemCommand,
  type GetItemCommandOutput,
  PutItemCommand,
  type PutItemCommandOutput,
  QueryCommand,
  type QueryCommandOutput,
  UpdateItemCommand,
  type UpdateItemCommandOutput,
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDbService,
  type DynamoDbServiceSchema,
} from '@packages/backend-core';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { Effect, Layer } from 'effect';

// TODO: move to constants
const httpHandler = new NodeHttpHandler({
  connectionTimeout: 300,
  socketTimeout: 1000,
  requestTimeout: 1500,
  httpsAgent: new Agent({ keepAlive: true }),
});

const normalizeAwsError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

const makeDynamoDbService = (): Effect.Effect<
  DynamoDbServiceSchema,
  never,
  never
> => {
  return Effect.sync(() => {
    const client = new DynamoDBClient({
      region: process.env.AWS_REGION,
      requestHandler: httpHandler,
      maxAttempts: 2,
    });

    const service = {
      getItem: (input): Effect.Effect<GetItemCommandOutput, Error> => {
        return Effect.tryPromise({
          try: () => client.send(new GetItemCommand(input)),
          // TODO: Check what error types we can make
          catch: normalizeAwsError,
        });
      },
      putItem: (input): Effect.Effect<PutItemCommandOutput, Error> => {
        return Effect.tryPromise({
          try: () => client.send(new PutItemCommand(input)),
          // TODO: Check what error types we can make
          catch: normalizeAwsError,
        });
      },
      updateItem: (input): Effect.Effect<UpdateItemCommandOutput, Error> => {
        return Effect.tryPromise({
          try: () => client.send(new UpdateItemCommand(input)),
          // TODO: Check what error types we can make
          catch: normalizeAwsError,
        });
      },
      query: (input): Effect.Effect<QueryCommandOutput, Error> => {
        return Effect.tryPromise({
          try: () => client.send(new QueryCommand(input)),
          // TODO: Check what error types we can make
          catch: normalizeAwsError,
        });
      },
    } satisfies DynamoDbServiceSchema;

    return service;
  });
};

export const LiveDynamoDbService = Layer.effect(
  DynamoDbService,
  makeDynamoDbService(),
);

export { DynamoDbService } from '@packages/backend-core';
