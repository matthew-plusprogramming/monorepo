import {
  EventBridgeService,
  type EventBridgeServiceSchema,
} from '@packages/backend-core';
import { Effect } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LiveEventBridgeService } from '@/services/eventBridge.service';

type EventBridgeMocks = {
  sendMock: ReturnType<
    typeof vi.fn<
      (command: { input: Record<string, unknown> }) => Promise<unknown>
    >
  >;
  lastClientConfig?: Record<string, unknown>;
  httpHandlerConfig?: Record<string, unknown>;
};

const mocks = vi.hoisted<EventBridgeMocks>(() => ({
  sendMock:
    vi.fn<(command: { input: Record<string, unknown> }) => Promise<unknown>>(),
  lastClientConfig: undefined,
  httpHandlerConfig: undefined,
}));

vi.mock('@aws-sdk/client-eventbridge', () => {
  class PutEventsCommand<TInput> {
    public readonly input: TInput;

    public constructor(input: TInput) {
      this.input = input;
    }
  }

  return {
    EventBridgeClient: vi.fn(function MockEventBridgeClient(
      this: { send: typeof mocks.sendMock },
      config: Record<string, unknown>,
    ) {
      mocks.lastClientConfig = config;
      this.send = mocks.sendMock;
    }),
    PutEventsCommand,
  };
});

vi.mock('@smithy/node-http-handler', () => ({
  NodeHttpHandler: vi.fn(function MockNodeHttpHandler(
    this: { config: Record<string, unknown> },
    config: Record<string, unknown>,
  ) {
    this.config = config;
    mocks.httpHandlerConfig = config;
  }),
}));

const useService = <R>(
  run: (service: EventBridgeServiceSchema) => Effect.Effect<R, Error>,
): Promise<R> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* EventBridgeService;
      return yield* run(service);
    }).pipe(Effect.provide(LiveEventBridgeService)),
  );

const initializeEventBridgeContext = (): void => {
  mocks.sendMock.mockReset();
  mocks.lastClientConfig = undefined;
  vi.stubEnv('AWS_REGION', 'us-east-1');
};

const cleanupEventBridgeContext = (): void => {
  vi.unstubAllEnvs();
};

const publishesEventsThroughClient = async (): Promise<void> => {
  // Arrange
  const entries = [
    {
      Detail: JSON.stringify({ hello: 'world' }),
      DetailType: 'test-detail',
      EventBusName: 'analytics-bus',
      Source: 'unit-test',
    },
  ];
  mocks.sendMock.mockResolvedValueOnce({ $metadata: { httpStatusCode: 200 } });

  // Act
  const result = await useService((service) =>
    service.putEvents({ Entries: entries }),
  );

  // Assert
  expect(result).toMatchObject({ $metadata: { httpStatusCode: 200 } });
  expect(mocks.lastClientConfig).toMatchObject({
    region: 'us-east-1',
    maxAttempts: 2,
  });
  expect(mocks.httpHandlerConfig).toMatchObject({
    connectionTimeout: 300,
    socketTimeout: 1000,
    requestTimeout: 1500,
  });
  const command = mocks.sendMock.mock.calls[0]?.[0];
  if (!command) {
    throw new Error('EventBridge client did not receive a command');
  }
  expect(command.input).toEqual({ Entries: entries });
};

const wrapsRejectionsAsErrors = async (): Promise<void> => {
  // Arrange
  mocks.sendMock.mockRejectedValueOnce('network unavailable');

  // Act
  const action = useService((service) =>
    service.putEvents({ Entries: [{ Detail: '{}', DetailType: 'noop' }] }),
  );

  // Assert
  await expect(action).rejects.toMatchObject({
    message: 'network unavailable',
  });
};

describe('EventBridgeService adapter', () => {
  beforeEach(initializeEventBridgeContext);
  afterEach(cleanupEventBridgeContext);

  it(
    'publishes events through the AWS client with retry-aware config',
    publishesEventsThroughClient,
  );
  it(
    'wraps EventBridge rejections into Error instances',
    wrapsRejectionsAsErrors,
  );
});
