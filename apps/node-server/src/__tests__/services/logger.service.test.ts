import type { LoggerServiceSchema } from '@packages/backend-core';
import { LoggerService } from '@packages/backend-core';
import type { Layer } from 'effect';
import { Effect } from 'effect';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

type LogCommandInput = {
  readonly logGroupName: string;
  readonly logStreamName: string;
  readonly logEvents: Array<{
    readonly timestamp: number;
    readonly message: string;
  }>;
};

type LoggerLayer = Layer.Layer<LoggerService, never, never>;

const setup = vi.hoisted(() => {
  (globalThis as typeof globalThis & { __BUNDLED__: boolean }).__BUNDLED__ =
    false;
  return {
    sendMock:
      vi.fn<
        (command: { readonly input: LogCommandInput }) => Promise<unknown>
      >(),
    clientConfigs: [] as Array<Record<string, unknown>>,
  };
});

const { sendMock, clientConfigs } = setup;

vi.mock('@aws-sdk/client-cloudwatch-logs', () => {
  class CloudWatchLogsClient {
    public constructor(config: Record<string, unknown>) {
      clientConfigs.push(config);
    }

    public send(command: {
      readonly input: LogCommandInput;
    }): Promise<unknown> {
      return sendMock(command);
    }
  }

  class PutLogEventsCommand<TInput> {
    public readonly input: TInput;

    public constructor(input: TInput) {
      this.input = input;
    }
  }

  return { CloudWatchLogsClient, PutLogEventsCommand };
});

vi.mock('@smithy/node-http-handler', () => ({
  NodeHttpHandler: class NodeHttpHandler {
    public constructor() {}
  },
}));

vi.mock('@/clients/cdkOutputs', () => ({
  applicationLogGroupName: 'app-log-group',
  serverLogStreamName: 'app-log-stream',
  securityLogGroupName: 'sec-log-group',
  securityLogStreamName: 'sec-log-stream',
}));

let ApplicationLoggerService: LoggerLayer;
let SecurityLoggerService: LoggerLayer;

beforeAll(async () => {
  ({ ApplicationLoggerService, SecurityLoggerService } = await import(
    '@/services/logger.service'
  ));
});

describe('LoggerService CloudWatch adapter', () => {
  const runWithLayer = <R>(
    layer: LoggerLayer,
    use: (service: LoggerServiceSchema) => Effect.Effect<R, never>,
  ): Promise<R> =>
    Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* LoggerService;
        return yield* use(service);
      }).pipe(Effect.provide(layer)),
    );

  beforeEach(() => {
    sendMock.mockReset();
    clientConfigs.length = 0;
    process.env.AWS_REGION = 'us-east-1';
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    Reflect.deleteProperty(process.env, 'AWS_REGION');
  });

  it('writes log events to CloudWatch Logs', async () => {
    vi.useFakeTimers();
    const now = new Date('2024-01-01T00:00:00.000Z');
    vi.setSystemTime(now);

    const output = { $metadata: { httpStatusCode: 200 } };
    sendMock.mockResolvedValueOnce(output);

    const result = await runWithLayer(ApplicationLoggerService, (service) =>
      service.log('hello world'),
    );

    expect(result).toBe(output);
    expect(sendMock).toHaveBeenCalledTimes(1);

    const command = sendMock.mock.calls[0]?.[0] as {
      readonly input: LogCommandInput;
    };
    expect(command?.input).toMatchObject({
      logGroupName: 'app-log-group',
      logStreamName: 'app-log-stream',
      logEvents: [
        {
          timestamp: now.getTime(),
          message: 'hello world',
        },
      ],
    });

    expect(clientConfigs[0]).toBeDefined();
    expect(clientConfigs[0]).toMatchObject({
      region: process.env.AWS_REGION,
      maxAttempts: 2,
    });
  });

  it('falls back to console logging when CloudWatch write fails', async () => {
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    sendMock.mockRejectedValueOnce(new Error('cloudwatch down'));

    const result = await runWithLayer(ApplicationLoggerService, (service) =>
      service.log('critical failure'),
    );

    expect(result).toMatchObject({ $metadata: { httpStatusCode: 500 } });
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[ERROR] Failed to put cloudwatch logs:',
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.any(Error));
  });

  it('emits two log events when logError is invoked', async () => {
    const first = { $metadata: { httpStatusCode: 200 } };
    const second = { $metadata: { httpStatusCode: 200 } };
    sendMock.mockResolvedValueOnce(first);
    sendMock.mockResolvedValueOnce(second);

    const error = new Error('boom');
    error.stack = 'STACK';

    const result = await runWithLayer(SecurityLoggerService, (service) =>
      service.logError(error),
    );

    expect(result).toBe(second);
    expect(sendMock).toHaveBeenCalledTimes(2);

    const firstCall = sendMock.mock.calls[0];
    const secondCall = sendMock.mock.calls[1];
    expect(firstCall).toBeDefined();
    expect(secondCall).toBeDefined();

    const [firstCommand] = firstCall as [{ readonly input: LogCommandInput }];
    const [secondCommand] = secondCall as [{ readonly input: LogCommandInput }];

    expect(firstCommand.input.logGroupName).toBe('sec-log-group');
    expect(firstCommand.input.logStreamName).toBe('sec-log-stream');
    expect(firstCommand.input.logEvents[0]?.message).toBe('[ERROR] boom');

    expect(secondCommand.input.logEvents[0]?.message).toBe('STACK');
  });

  it('uses console logger when bundled', async () => {
    const consoleInfo = vi
      .spyOn(console, 'info')
      .mockImplementation(() => undefined);
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    vi.resetModules();
    (globalThis as typeof globalThis & { __BUNDLED__: boolean }).__BUNDLED__ =
      true;
    const { ApplicationLoggerService: BundledLayer } = await import(
      '@/services/logger.service'
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* LoggerService;
        yield* service.log('console message');
        yield* service.logError(new Error('console boom'));
      }).pipe(Effect.provide(BundledLayer)),
    );

    expect(consoleInfo).toHaveBeenCalledWith('console message');
    expect(consoleError).toHaveBeenCalledWith('[ERROR]', 'console boom');
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('Error: console boom'),
    );

    vi.resetModules();
    (globalThis as typeof globalThis & { __BUNDLED__: boolean }).__BUNDLED__ =
      false;
    ({ ApplicationLoggerService, SecurityLoggerService } = await import(
      '@/services/logger.service'
    ));
  });
});
