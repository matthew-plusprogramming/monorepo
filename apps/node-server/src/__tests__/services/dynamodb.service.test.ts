import type { DynamoDbServiceSchema } from '@packages/backend-core';
import { Effect } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DynamoDbService,
  LiveDynamoDbService,
} from '@/services/dynamodb.service';

type CommandWithInput<T = Record<string, unknown>> = { readonly input: T };

const mocks = vi.hoisted(() => ({
  sendMock: vi.fn<(command: CommandWithInput) => Promise<unknown>>(),
  lastClientConfig: undefined as Record<string, unknown> | undefined,
  httpHandlerConfig: undefined as Record<string, unknown> | undefined,
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
  const useService = <R>(
    run: (service: DynamoDbServiceSchema) => Effect.Effect<R, Error>,
  ): Promise<R> =>
    Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* DynamoDbService;
        return yield* run(service);
      }).pipe(Effect.provide(LiveDynamoDbService)),
    );

  beforeEach(() => {
    sendMock.mockReset();
    mocks.lastClientConfig = undefined;
    process.env.AWS_REGION = 'us-east-1';
  });

  afterEach(() => {
    Reflect.deleteProperty(process.env, 'AWS_REGION');
  });

  it('sends GetItemCommand via AWS client and returns the response', async () => {
    const output = { $metadata: { httpStatusCode: 200 } };
    sendMock.mockResolvedValueOnce(output);

    const result = await useService((service) =>
      service.getItem({
        TableName: 'users',
        Key: { id: { S: 'id-123' } },
      }),
    );

    expect(result).toBe(output);
    expect(sendMock).toHaveBeenCalledTimes(1);
    const command = sendMock.mock.calls[0]?.[0] as CommandWithInput;
    expect(command?.input).toEqual({
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
  });

  it('wraps AWS rejections into Error instances', async () => {
    sendMock.mockRejectedValueOnce('network unavailable');

    await expect(
      useService((service) => service.query({ TableName: 'users' })),
    ).rejects.toMatchObject({ message: 'network unavailable' });
  });

  it('allows updating items through the adapter', async () => {
    const output = { $metadata: { httpStatusCode: 200 }, Attributes: {} };
    sendMock.mockResolvedValueOnce(output);

    const result = await useService((service) =>
      service.updateItem({ TableName: 'users', Key: { id: { S: '123' } } }),
    );

    expect(result).toBe(output);
    const command = sendMock.mock.calls[0]?.[0] as CommandWithInput;
    expect(command?.input).toMatchObject({
      TableName: 'users',
      Key: { id: { S: '123' } },
    });
  });

  it('writes items with putItem', async () => {
    const output = { $metadata: { httpStatusCode: 200 } };
    sendMock.mockResolvedValueOnce(output);

    const result = await useService((service) =>
      service.putItem({
        TableName: 'users',
        Item: { id: { S: 'new-user' } },
      }),
    );

    expect(result).toBe(output);
    expect(sendMock).toHaveBeenCalledTimes(1);
    const command = sendMock.mock.calls[0]?.[0] as CommandWithInput;
    expect(command?.input).toEqual({
      TableName: 'users',
      Item: { id: { S: 'new-user' } },
    });
  });

  it('propagates putItem failures as Errors', async () => {
    sendMock.mockRejectedValueOnce('write failed');

    await expect(
      useService((service) =>
        service.putItem({
          TableName: 'users',
          Item: { id: { S: 'new-user' } },
        }),
      ),
    ).rejects.toMatchObject({ message: 'write failed' });
  });
});
