import type { DynamoDbServiceSchema } from '@packages/backend-core';
import { Effect } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DynamoDbService,
  LiveDynamoDbService,
} from '@/services/dynamodb.service';

type CommandWithInput<T = Record<string, unknown>> = { readonly input: T };

type DynamoMocks = {
  sendMock: ReturnType<
    typeof vi.fn<(command: CommandWithInput) => Promise<unknown>>
  >;
  lastClientConfig: Record<string, unknown> | undefined;
  httpHandlerConfig: Record<string, unknown> | undefined;
};

const mocks = vi.hoisted<DynamoMocks>(() => ({
  sendMock: vi.fn<(command: CommandWithInput) => Promise<unknown>>(),
  lastClientConfig: undefined,
  httpHandlerConfig: undefined,
}));

const { sendMock } = mocks;

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient {
    public constructor(config: Record<string, unknown>) {
      mocks.lastClientConfig = config;
    }

    public send(command: CommandWithInput): Promise<unknown> {
      return mocks.sendMock(command);
    }
  }

  class BaseCommand<TInput> {
    public readonly input: TInput;

    public constructor(input: TInput) {
      this.input = input;
    }
  }

  return {
    DynamoDBClient,
    GetItemCommand: class GetItemCommand<TInput> extends BaseCommand<TInput> {},
    PutItemCommand: class PutItemCommand<TInput> extends BaseCommand<TInput> {},
    QueryCommand: class QueryCommand<TInput> extends BaseCommand<TInput> {},
    UpdateItemCommand: class UpdateItemCommand<
      TInput,
    > extends BaseCommand<TInput> {},
  };
});

vi.mock('@smithy/node-http-handler', () => ({
  NodeHttpHandler: class NodeHttpHandler {
    public readonly config: Record<string, unknown>;

    public constructor(config: Record<string, unknown>) {
      this.config = config;
      mocks.httpHandlerConfig = config;
    }
  },
}));

describe('DynamoDbService adapter', () => {
  beforeEach(initializeDynamoContext);
  afterEach(cleanupDynamoContext);

  it(
    'sends GetItemCommand via AWS client and returns the response',
    sendsGetItemCommand,
  );
  it('wraps AWS rejections into Error instances', wrapsRejectionsAsErrors);
  it('allows updating items through the adapter', allowsUpdateItem);
  it('writes items with putItem', writesItemsWithPutItem);
  it('propagates putItem failures as Errors', propagatesPutItemFailures);
});

const useService = <R>(
  run: (service: DynamoDbServiceSchema) => Effect.Effect<R, Error>,
): Promise<R> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* DynamoDbService;
      return yield* run(service);
    }).pipe(Effect.provide(LiveDynamoDbService)),
  );

function initializeDynamoContext(): void {
  sendMock.mockReset();
  mocks.lastClientConfig = undefined;
  process.env.AWS_REGION = 'us-east-1';
}

function cleanupDynamoContext(): void {
  Reflect.deleteProperty(process.env, 'AWS_REGION');
}

async function sendsGetItemCommand(): Promise<void> {
  // Arrange
  const output = { $metadata: { httpStatusCode: 200 } };
  sendMock.mockResolvedValueOnce(output);

  // Act
  const result = await useService((service) =>
    service.getItem({
      TableName: 'users',
      Key: { id: { S: 'id-123' } },
    }),
  );

  // Assert
  expect(result).toBe(output);
  expect(sendMock).toHaveBeenCalledTimes(1);
  const command = sendMock.mock.calls[0]?.[0];
  if (!command) {
    throw new Error('AWS client did not receive a command');
  }
  expect(command.input).toEqual({
    TableName: 'users',
    Key: { id: { S: 'id-123' } },
  });

  expect(mocks.lastClientConfig).toMatchObject({
    region: 'us-east-1',
    maxAttempts: 2,
  });
  expect(mocks.httpHandlerConfig).toMatchObject({
    connectionTimeout: 300,
    socketTimeout: 1000,
    requestTimeout: 1500,
  });
}

async function wrapsRejectionsAsErrors(): Promise<void> {
  // Arrange
  sendMock.mockRejectedValueOnce('network unavailable');

  // Act
  const action = useService((service) => service.query({ TableName: 'users' }));

  // Assert
  await expect(action).rejects.toMatchObject({
    message: 'network unavailable',
  });
}

async function allowsUpdateItem(): Promise<void> {
  // Arrange
  const output = { $metadata: { httpStatusCode: 200 }, Attributes: {} };
  sendMock.mockResolvedValueOnce(output);

  // Act
  const result = await useService((service) =>
    service.updateItem({ TableName: 'users', Key: { id: { S: '123' } } }),
  );

  // Assert
  expect(result).toBe(output);
  const command = sendMock.mock.calls[0]?.[0];
  if (!command) {
    throw new Error('AWS client did not receive a command');
  }
  expect(command.input).toMatchObject({
    TableName: 'users',
    Key: { id: { S: '123' } },
  });
}

async function writesItemsWithPutItem(): Promise<void> {
  // Arrange
  const output = { $metadata: { httpStatusCode: 200 } };
  sendMock.mockResolvedValueOnce(output);

  // Act
  const result = await useService((service) =>
    service.putItem({
      TableName: 'users',
      Item: { id: { S: 'new-user' } },
    }),
  );

  // Assert
  expect(result).toBe(output);
  expect(sendMock).toHaveBeenCalledTimes(1);
  const command = sendMock.mock.calls[0]?.[0];
  if (!command) {
    throw new Error('AWS client did not receive a command');
  }
  expect(command.input).toEqual({
    TableName: 'users',
    Item: { id: { S: 'new-user' } },
  });
}

async function propagatesPutItemFailures(): Promise<void> {
  // Arrange
  sendMock.mockRejectedValueOnce('write failed');

  // Act
  const action = useService((service) =>
    service.putItem({
      TableName: 'users',
      Item: { id: { S: 'new-user' } },
    }),
  );

  // Assert
  await expect(action).rejects.toMatchObject({ message: 'write failed' });
}
