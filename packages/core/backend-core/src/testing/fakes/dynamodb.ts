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
import { Effect, Layer } from 'effect';

import {
  DynamoDbService,
  type DynamoDbServiceSchema,
} from '@/services/dynamodb.js';

const operations = ['getItem', 'putItem', 'query', 'updateItem'] as const;
type OperationName = (typeof operations)[number];

type ResponseEntry<T> =
  | { type: 'success'; value: T }
  | { type: 'error'; error: Error };

type ResponseQueues = {
  readonly getItem: Array<ResponseEntry<GetItemCommandOutput>>;
  readonly putItem: Array<ResponseEntry<PutItemCommandOutput>>;
  readonly query: Array<ResponseEntry<QueryCommandOutput>>;
  readonly updateItem: Array<ResponseEntry<UpdateItemCommandOutput>>;
};

type CallHistory = {
  readonly getItem: Array<GetItemCommandInput>;
  readonly putItem: Array<PutItemCommandInput>;
  readonly query: Array<QueryCommandInput>;
  readonly updateItem: Array<UpdateItemCommandInput>;
};

export type DynamoDbServiceFake = {
  readonly service: DynamoDbServiceSchema;
  readonly layer: Layer.Layer<DynamoDbService, never, never>;
  readonly queueSuccess: {
    (operation: 'getItem', output: GetItemCommandOutput): void;
    (operation: 'putItem', output: PutItemCommandOutput): void;
    (operation: 'query', output: QueryCommandOutput): void;
    (operation: 'updateItem', output: UpdateItemCommandOutput): void;
  };
  readonly queueFailure: (operation: OperationName, error: Error) => void;
  readonly calls: CallHistory;
  readonly reset: () => void;
};

const createDefaultOutputError = (operation: OperationName): Error =>
  new Error(`No response queued for DynamoDbService.${operation}`);

const dequeue = <T>(
  queue: Array<ResponseEntry<T>>,
  operation: OperationName,
): Effect.Effect<T, Error> => {
  const next = queue.shift();
  if (!next) {
    return Effect.fail(createDefaultOutputError(operation));
  }

  if (next.type === 'success') {
    return Effect.succeed(next.value);
  }

  return Effect.fail(next.error);
};

export const createDynamoDbServiceFake = (): DynamoDbServiceFake => {
  const responseQueues: ResponseQueues = {
    getItem: [],
    putItem: [],
    query: [],
    updateItem: [],
  };

  const callHistory: CallHistory = {
    getItem: [],
    putItem: [],
    query: [],
    updateItem: [],
  };

  const service: DynamoDbServiceSchema = {
    getItem: (input: GetItemCommandInput) =>
      Effect.sync(() => {
        callHistory.getItem.push(input);
      }).pipe(Effect.flatMap(() => dequeue(responseQueues.getItem, 'getItem'))),
    putItem: (input: PutItemCommandInput) =>
      Effect.sync(() => {
        callHistory.putItem.push(input);
      }).pipe(Effect.flatMap(() => dequeue(responseQueues.putItem, 'putItem'))),
    query: (input: QueryCommandInput) =>
      Effect.sync(() => {
        callHistory.query.push(input);
      }).pipe(Effect.flatMap(() => dequeue(responseQueues.query, 'query'))),
    updateItem: (input: UpdateItemCommandInput) =>
      Effect.sync(() => {
        callHistory.updateItem.push(input);
      }).pipe(
        Effect.flatMap(() => dequeue(responseQueues.updateItem, 'updateItem')),
      ),
  };

  return {
    service,
    layer: Layer.succeed(DynamoDbService, service),
    queueSuccess: (operation, output): void => {
      responseQueues[operation].push({ type: 'success', value: output });
    },
    queueFailure: (operation, error): void => {
      responseQueues[operation].push({ type: 'error', error });
    },
    calls: callHistory,
    reset: (): void => {
      for (const operation of operations) {
        responseQueues[operation].length = 0;
        callHistory[operation].length = 0;
      }
    },
  };
};
