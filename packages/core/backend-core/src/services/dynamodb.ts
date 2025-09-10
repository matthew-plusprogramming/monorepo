import type {
  GetItemCommandInput,
  GetItemCommandOutput,
  PutItemCommandInput,
  PutItemCommandOutput,
  QueryCommandInput,
  QueryCommandOutput,
  UpdateItemCommandInput,
  UpdateItemCommandOutput,
} from '@aws-sdk/client-dynamodb';
import { Context, type Effect } from 'effect';

export type DynamoDbServiceSchema = {
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

export class DynamoDbService extends Context.Tag('DynamoDbService')<
  DynamoDbService,
  DynamoDbServiceSchema
>() {}
