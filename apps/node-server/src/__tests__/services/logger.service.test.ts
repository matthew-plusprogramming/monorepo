import type { LoggerServiceSchema } from '@packages/backend-core';
import { LoggerService } from '@packages/backend-core';
import type { Layer } from 'effect';
import { Effect } from 'effect';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

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
    const consoleInfo = vi
      .spyOn(console, 'info')
      .mockImplementation(() => undefined);

    const result = await runWithLayer(ApplicationLoggerService, (service) =>
      service.log('hello world', 123, { extra: true }),
    );

    expect(consoleInfo).toHaveBeenCalledWith('hello world', 123, { extra: true });
    expect(result).toBeUndefined();
  });

  it('logs errors via console.error and resolves with undefined', async () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const error = new Error('boom');

    const result = await runWithLayer(SecurityLoggerService, (service) =>
      service.logError(error, 'during heartbeat'),
    );

    expect(consoleError).toHaveBeenCalledWith(error, 'during heartbeat');
    expect(result).toBeUndefined();
  });
});
