import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';

type ExpressAppStub = {
  use: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  listen: ReturnType<typeof vi.fn>;
};

type ExpressModuleState = {
  app: ExpressAppStub | undefined;
  factory: ReturnType<typeof vi.fn> | undefined;
  json: ReturnType<typeof vi.fn> | undefined;
  jsonMiddleware: ReturnType<typeof vi.fn> | undefined;
};

type SingleMockState = {
  handler: ReturnType<typeof vi.fn> | undefined;
};

type EnvironmentModuleState = {
  parse: ReturnType<typeof vi.fn> | undefined;
};

type EnvironmentParseImpl = (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;

const expressModule = vi.hoisted<ExpressModuleState>(() => ({
  app: undefined,
  factory: undefined,
  json: undefined,
  jsonMiddleware: undefined,
}));

const ipRateLimitModule = vi.hoisted<SingleMockState>(() => ({
  handler: undefined,
}));
const jsonErrorModule = vi.hoisted<SingleMockState>(() => ({
  handler: undefined,
}));
const registerModule = vi.hoisted<SingleMockState>(() => ({
  handler: undefined,
}));
const getUserModule = vi.hoisted<SingleMockState>(() => ({
  handler: undefined,
}));
const environmentModule = vi.hoisted<EnvironmentModuleState>(() => ({
  parse: undefined,
}));
const environmentParseImpl = vi.hoisted(() => ({
  impl: ((env) => env) as EnvironmentParseImpl,
}));

vi.hoisted(() => {
  (globalThis as typeof globalThis & { __BUNDLED__?: boolean }).__BUNDLED__ =
    false;
  return undefined;
});

vi.mock('@dotenvx/dotenvx/config', () => ({}));

vi.mock('express', () => {
  const use = vi.fn();
  const post = vi.fn();
  const get = vi.fn();
  const listen = vi.fn();
  const app: ExpressAppStub = { use, post, get, listen };
  const jsonMiddleware = vi.fn();
  const json = vi.fn(() => jsonMiddleware);
  const factory = vi.fn(() => app);
  Object.assign(factory, { json });

  expressModule.app = app;
  expressModule.factory = factory;
  expressModule.json = json;
  expressModule.jsonMiddleware = jsonMiddleware;

  return { default: factory };
});

vi.mock('@/middleware/ipRateLimiting.middleware', () => {
  const handler = vi.fn();
  ipRateLimitModule.handler = handler;
  return { ipRateLimitingMiddlewareRequestHandler: handler };
});

vi.mock('@/middleware/jsonError.middleware', () => {
  const handler = vi.fn();
  jsonErrorModule.handler = handler;
  return { jsonErrorMiddleware: handler };
});

vi.mock('@/handlers/register.handler', () => {
  const handler = vi.fn();
  registerModule.handler = handler;
  return { registerRequestHandler: handler };
});

vi.mock('@/handlers/getUser.handler', () => {
  const handler = vi.fn();
  getUserModule.handler = handler;
  return { getUserRequestHandler: handler };
});

vi.mock('@/clients/cdkOutputs', () => ({
  usersTableName: 'users-table',
  rateLimitTableName: 'rate-limit-table',
  denyListTableName: 'deny-list-table',
  analyticsEventBusArn: 'analytics-bus-arn',
  analyticsEventBusName: 'analytics-bus',
  analyticsDeadLetterQueueArn: 'analytics-dlq-arn',
  analyticsDeadLetterQueueUrl: 'https://example.com/dlq',
  analyticsDedupeTableName: 'analytics-dedupe-table',
  analyticsAggregateTableName: 'analytics-aggregate-table',
  analyticsEventLogGroupName: 'analytics-event-log-group',
  analyticsProcessorLogGroupName: 'analytics-processor-log-group',
}));

vi.mock('@/types/environment', () => {
  const parse = vi.fn((env: NodeJS.ProcessEnv) =>
    environmentParseImpl.impl(env),
  );
  environmentModule.parse = parse;
  return { EnvironmentSchema: { parse } };
});

describe('node-server index entrypoint', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    expressModule.app = undefined;
    expressModule.factory = undefined;
    expressModule.json = undefined;
    expressModule.jsonMiddleware = undefined;
    ipRateLimitModule.handler = undefined;
    jsonErrorModule.handler = undefined;
    registerModule.handler = undefined;
    getUserModule.handler = undefined;
    environmentModule.parse = undefined;
    environmentParseImpl.impl = (env): NodeJS.ProcessEnv => env;
    process.env.PORT = '3000' as unknown as number;
    exitSpy = vi.spyOn(process, 'exit') as ReturnType<typeof vi.spyOn>;
    exitSpy.mockImplementation(() => undefined as never);
    consoleErrorSpy = vi.spyOn(console, 'error') as ReturnType<typeof vi.spyOn>;
    consoleErrorSpy.mockImplementation(() => undefined);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    Reflect.deleteProperty(process.env, 'PORT');
  });

  it('bootstraps express app when environment validation succeeds', async () => {
    const module = await import('@/index');

    const expressApp = requireExpressApp();
    const parse = requireEnvironmentParse();
    const jsonMiddleware = requireExpressJsonMiddleware();

    expect(expressModule.factory).toHaveBeenCalledTimes(1);
    expect(parse).toHaveBeenCalledWith(process.env);
    expect(expressApp.use).toHaveBeenNthCalledWith(
      1,
      requireIpRateLimitMiddleware(),
    );
    expect(expressModule.json).toHaveBeenCalledTimes(1);
    expect(expressApp.use).toHaveBeenNthCalledWith(2, jsonMiddleware);
    expect(expressApp.use).toHaveBeenNthCalledWith(
      3,
      requireJsonErrorMiddleware(),
    );
    expect(expressApp.post).toHaveBeenCalledWith(
      '/register',
      requireRegisterHandler(),
    );
    expect(expressApp.get).toHaveBeenCalledWith(
      '/user/:identifier',
      requireGetUserHandler(),
    );
    expect(expressApp.listen).toHaveBeenCalledWith('3000');
    expect(module.app).toBe(expressApp);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('logs and exits when environment validation fails', async () => {
    const exitError = new Error('process exit invoked');
    exitSpy.mockImplementationOnce((() => {
      throw exitError;
    }) as never);

    environmentParseImpl.impl = (env): never => {
      void env;
      throw new ZodError([]);
    };

    await expect(import('@/index')).rejects.toBe(exitError);
    expect(consoleErrorSpy).toHaveBeenNthCalledWith(
      1,
      'Environment variables validation failed',
    );
    expect(consoleErrorSpy).toHaveBeenCalledTimes(2);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

function requireExpressApp(): ExpressAppStub {
  return ensureDefined(expressModule.app, 'express app');
}

function requireEnvironmentParse(): ReturnType<typeof vi.fn> {
  return ensureDefined(environmentModule.parse, 'EnvironmentSchema.parse mock');
}

function requireExpressJsonMiddleware(): ReturnType<typeof vi.fn> {
  return ensureDefined(expressModule.jsonMiddleware, 'express.json middleware');
}

function requireIpRateLimitMiddleware(): ReturnType<typeof vi.fn> {
  return ensureDefined(ipRateLimitModule.handler, 'ipRateLimiting middleware');
}

function requireJsonErrorMiddleware(): ReturnType<typeof vi.fn> {
  return ensureDefined(jsonErrorModule.handler, 'jsonError middleware');
}

function requireRegisterHandler(): ReturnType<typeof vi.fn> {
  return ensureDefined(registerModule.handler, 'register handler');
}

function requireGetUserHandler(): ReturnType<typeof vi.fn> {
  return ensureDefined(getUserModule.handler, 'getUser handler');
}

function ensureDefined<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw new Error(`${name} was not initialized`);
  }
  return value;
}
