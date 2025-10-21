import type { LoggerServiceSchema } from '@packages/backend-core';
import { LoggerService } from '@packages/backend-core';
import type { Layer } from 'effect';
import { Effect } from 'effect';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

type LoggerLayer = Layer.Layer<LoggerService, never, never>;

let ApplicationLoggerService: LoggerLayer;
let SecurityLoggerService: LoggerLayer;

beforeAll(async () => {
  ({ ApplicationLoggerService, SecurityLoggerService } = await import(
    '@/services/logger.service'
  ));
});

afterAll(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

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

describe('ConsoleLoggerService', () => {
  it('logs messages via console.info and resolves with undefined', async () => {
    // Arrange
    const consoleInfo = vi
      .spyOn(console, 'info')
      .mockImplementation(() => undefined);

    // Act
    const action = runWithLayer(ApplicationLoggerService, (service) =>
      service.log('hello world', 123, { extra: true }),
    );

    // Assert
    await expect(action).resolves.toBeUndefined();
    expect(consoleInfo).toHaveBeenCalledWith('hello world', 123, {
      extra: true,
    });
  });

  it('logs errors via console.error and resolves with undefined', async () => {
    // Arrange
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const error = new Error('boom');

    // Act
    const action = runWithLayer(SecurityLoggerService, (service) =>
      service.logError(error, 'during heartbeat'),
    );

    // Assert
    await expect(action).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalledWith(error, 'during heartbeat');
  });
});
