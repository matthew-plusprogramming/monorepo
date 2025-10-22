import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setBundledRuntime } from '@/__tests__/utils/runtime';

type ExpressAppStub = {
  use: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  listen: ReturnType<typeof vi.fn>;
};

type MockFn = ReturnType<typeof vi.fn>;

type ExpressModuleState = {
  app: ExpressAppStub | undefined;
  factory: MockFn | undefined;
  json: MockFn | undefined;
  jsonMiddleware: MockFn | undefined;
  use: MockFn | undefined;
  post: MockFn | undefined;
  get: MockFn | undefined;
  listen: MockFn | undefined;
};

type SingleMockState = {
  handler: MockFn | undefined;
};

type EnvironmentModuleState = {
  parse: MockFn | undefined;
};

type ServerlessModuleState = {
  factory: MockFn | undefined;
};

const expressModule = vi.hoisted<ExpressModuleState>(() => ({
  app: undefined,
  factory: undefined,
  json: undefined,
  jsonMiddleware: undefined,
  use: undefined,
  post: undefined,
  get: undefined,
  listen: undefined,
}));

const ipRateLimitModule = vi.hoisted<SingleMockState>(() => ({
  handler: undefined,
}));
const jsonErrorModule = vi.hoisted<SingleMockState>(() => ({
  handler: undefined,
}));
const heartbeatModule = vi.hoisted<SingleMockState>(() => ({
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
const serverlessModule = vi.hoisted<ServerlessModuleState>(() => ({
  factory: undefined,
}));
const isAuthenticatedModule = vi.hoisted<SingleMockState>(() => ({
  handler: undefined,
}));

const handlerStub = { type: 'lambda-handler' } as const;

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
  expressModule.use = use;
  expressModule.post = post;
  expressModule.get = get;
  expressModule.listen = listen;

  return { default: factory };
});

vi.mock('serverless-http', () => {
  const serverless = vi.fn(() => handlerStub);
  serverlessModule.factory = serverless;
  return { default: serverless };
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

vi.mock('@/handlers/heartbeat.handler', () => {
  const handler = vi.fn();
  heartbeatModule.handler = handler;
  return { heartbeatRequestHandler: handler };
});

vi.mock('@/handlers/getUser.handler', () => {
  const handler = vi.fn();
  getUserModule.handler = handler;
  return { getUserRequestHandler: handler };
});

vi.mock('@/types/environment', () => {
  const parse = vi.fn();
  environmentModule.parse = parse;
  return { EnvironmentSchema: { parse } };
});

vi.mock('@/middleware/isAuthenticated.middleware', () => {
  const handler = vi.fn();
  isAuthenticatedModule.handler = handler;
  return { isAuthenticatedMiddlewareRequestHandler: handler };
});

describe('lambda entrypoint', () => {
  beforeEach(() => {
    vi.resetModules();
    setBundledRuntime(false);
  });

  it('wraps the Express app with serverless-http and exports the handler', async () => {
    // Arrange
    // Default mocks wired in module scope establish expectations

    // Act
    const module = await import('@/lambda');

    // Assert
    const expressApp = requireExpressApp();
    const serverless = requireServerless();
    const envParse = requireEnvironmentParse();

    expect(expressModule.factory).toHaveBeenCalledTimes(1);
    expect(envParse).toHaveBeenCalledWith(process.env);
    expect(expressModule.json).toHaveBeenCalledTimes(1);

    expect(expressApp.use).toHaveBeenNthCalledWith(
      1,
      requireIpRateLimitMiddleware(),
    );
    expect(expressApp.use).toHaveBeenNthCalledWith(2, requireJsonMiddleware());
    expect(expressApp.use).toHaveBeenNthCalledWith(
      3,
      requireJsonErrorMiddleware(),
    );

    expect(expressApp.get).toHaveBeenNthCalledWith(
      1,
      '/heartbeat',
      requireIsAuthenticatedMiddleware(),
      requireHeartbeatHandler(),
    );
    expect(expressApp.post).toHaveBeenCalledWith(
      '/register',
      requireRegisterHandler(),
    );
    expect(expressApp.get).toHaveBeenCalledWith(
      '/user/:identifier',
      requireGetUserHandler(),
    );
    expect(expressApp.listen).toHaveBeenCalledWith(undefined);

    expect(serverless).toHaveBeenCalledTimes(1);
    expect(serverless).toHaveBeenCalledWith(expressApp);
    expect(module.handler).toBe(handlerStub);
  });
});

function requireExpressApp(): ExpressAppStub {
  return ensureDefined(expressModule.app, 'express app');
}

function requireServerless(): MockFn {
  return ensureDefined(serverlessModule.factory, 'serverless-http mock');
}

function requireEnvironmentParse(): MockFn {
  return ensureDefined(environmentModule.parse, 'EnvironmentSchema.parse mock');
}

function requireIpRateLimitMiddleware(): MockFn {
  return ensureDefined(ipRateLimitModule.handler, 'ipRateLimiting middleware');
}

function requireJsonErrorMiddleware(): MockFn {
  return ensureDefined(jsonErrorModule.handler, 'jsonError middleware');
}

function requireRegisterHandler(): MockFn {
  return ensureDefined(registerModule.handler, 'register handler');
}

function requireHeartbeatHandler(): MockFn {
  return ensureDefined(heartbeatModule.handler, 'heartbeat handler');
}

function requireGetUserHandler(): MockFn {
  return ensureDefined(getUserModule.handler, 'getUser handler');
}

function requireJsonMiddleware(): MockFn {
  return ensureDefined(expressModule.jsonMiddleware, 'express.json middleware');
}

function requireIsAuthenticatedMiddleware(): MockFn {
  return ensureDefined(
    isAuthenticatedModule.handler,
    'isAuthenticated middleware',
  );
}

function ensureDefined<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw new Error(`${name} was not initialized`);
  }
  return value;
}
