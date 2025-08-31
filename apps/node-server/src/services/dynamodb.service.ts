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
} from '@aws-sdk/client-dynamodb';
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
};

const makeDynamoDbService = (): Effect.Effect<
  DynamoDbServiceSchema,
  never,
  never
> => {
  return Effect.sync(() => {
    const client = new DynamoDBClient();

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
