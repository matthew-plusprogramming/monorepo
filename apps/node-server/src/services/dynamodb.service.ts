import { Agent } from 'node:https';

import {
  DynamoDBClient,
  GetItemCommand,
  type GetItemCommandInput,
  type GetItemCommandOutput,
  PutItemCommand,
  type PutItemCommandInput,
  type PutItemCommandOutput,
  QueryCommand,
  type QueryCommandInput,
  type QueryCommandOutput,
  UpdateItemCommand,
  type UpdateItemCommandInput,
  type UpdateItemCommandOutput,
} from '@aws-sdk/client-dynamodb';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { Context, Effect, Layer } from 'effect';

type DynamoDbServiceSchema = {
  readonly getItem: (
    input: GetItemCommandInput,
  ) => Effect.Effect<GetItemCommandOutput, Error>;

  readonly putItem: (
    input: PutItemCommandInput,
  ) => Effect.Effect<PutItemCommandOutput, Error>;

  readonly query: (
    input: QueryCommandInput,
  ) => Effect.Effect<QueryCommandOutput, Error>;

  readonly updateItem: (
    input: UpdateItemCommandInput,
  ) => Effect.Effect<UpdateItemCommandOutput, Error>;
};

// TODO: move to constants
const httpHandler = new NodeHttpHandler({
  connectionTimeout: 300,
  socketTimeout: 1000,
  requestTimeout: 1500,
  httpsAgent: new Agent({ keepAlive: true }),
});

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
          catch: (error) => new Error(error as string),
        });
      },
      putItem: (input): Effect.Effect<PutItemCommandOutput, Error> => {
        return Effect.tryPromise({
          try: () => client.send(new PutItemCommand(input)),
          // TODO: Check what error types we can make
          catch: (error) => new Error(error as string),
        });
      },
      updateItem: (input): Effect.Effect<UpdateItemCommandOutput, Error> => {
        return Effect.tryPromise({
          try: () => client.send(new UpdateItemCommand(input)),
          // TODO: Check what error types we can make
          catch: (error) => new Error(error as string),
        });
      },
      query: (input): Effect.Effect<QueryCommandOutput, Error> => {
        return Effect.tryPromise({
          try: () => client.send(new QueryCommand(input)),
          // TODO: Check what error types we can make
          catch: (error) => new Error(error as string),
        });
      },
    } satisfies DynamoDbServiceSchema;

    return service;
  });
};

export class DynamoDbService extends Context.Tag('DynamoDbService')<
  DynamoDbService,
  DynamoDbServiceSchema
>() {}

export const LiveDynamoDbService = Layer.effect(
  DynamoDbService,
  makeDynamoDbService(),
);
