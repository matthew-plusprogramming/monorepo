import { setBundledRuntime } from '@packages/backend-core/testing';
import type { MockInstance } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';

import { makeCdkOutputsStub } from '@/__tests__/stubs/cdkOutputs';
import { ensureDefined } from '@/__tests__/utils/ensureDefined';

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

const corsModule = vi.hoisted<SingleMockState>(() => ({
  handler: undefined,
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
type EnvironmentParseState = {
  impl: EnvironmentParseImpl;
};

const environmentParseImpl = vi.hoisted<EnvironmentParseState>(() => ({
  impl: (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => env,
}));

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

vi.mock('cors', () => {
  const handler = vi.fn();
  const factory = vi.fn(() => handler);
  corsModule.handler = handler;
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

vi.mock('@/clients/cdkOutputs', () => makeCdkOutputsStub());

vi.mock('@/types/environment', () => {
  const parse = vi.fn((env: NodeJS.ProcessEnv) =>
    environmentParseImpl.impl(env),
  );
  environmentModule.parse = parse;
  return { EnvironmentSchema: { parse } };
});

const requireExpressApp = (): ExpressAppStub => {
  return ensureDefined(expressModule.app, 'express app');
};

const requireEnvironmentParse = (): ReturnType<typeof vi.fn> => {
  return ensureDefined(environmentModule.parse, 'EnvironmentSchema.parse mock');
};

const requireExpressJsonMiddleware = (): ReturnType<typeof vi.fn> => {
  return ensureDefined(expressModule.jsonMiddleware, 'express.json middleware');
};

const requireCorsMiddleware = (): ReturnType<typeof vi.fn> => {
  return ensureDefined(corsModule.handler, 'cors middleware');
};

const requireIpRateLimitMiddleware = (): ReturnType<typeof vi.fn> => {
  return ensureDefined(ipRateLimitModule.handler, 'ipRateLimiting middleware');
};

const requireJsonErrorMiddleware = (): ReturnType<typeof vi.fn> => {
  return ensureDefined(jsonErrorModule.handler, 'jsonError middleware');
};

const requireRegisterHandler = (): ReturnType<typeof vi.fn> => {
  return ensureDefined(registerModule.handler, 'register handler');
};

const requireGetUserHandler = (): ReturnType<typeof vi.fn> => {
  return ensureDefined(getUserModule.handler, 'getUser handler');
};

const assertBootstrapSuccess = ({
  module,
  exitSpy,
}: {
  module: { app?: unknown };
  exitSpy: MockInstance<typeof process.exit>;
}): void => {
  const expressApp = requireExpressApp();
  const parse = requireEnvironmentParse();
  const jsonMiddleware = requireExpressJsonMiddleware();

  expect(expressModule.factory).toHaveBeenCalledTimes(1);
  expect(parse).toHaveBeenCalledWith(process.env);
  expect(expressApp.use).toHaveBeenNthCalledWith(1, requireCorsMiddleware());
  expect(expressApp.use).toHaveBeenNthCalledWith(
    2,
    requireIpRateLimitMiddleware(),
  );
  expect(expressModule.json).toHaveBeenCalledTimes(1);
  expect(expressApp.use).toHaveBeenNthCalledWith(3, jsonMiddleware);
  expect(expressApp.use).toHaveBeenNthCalledWith(
    4,
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
  expect(expressApp.listen).toHaveBeenCalledWith(process.env.PORT);
  const moduleApp = module.app;
  expect(moduleApp).toBe(expressApp);
  expect(exitSpy).not.toHaveBeenCalled();
};

const assertBootstrapFailure = ({
  consoleErrorSpy,
  exitSpy,
}: {
  consoleErrorSpy: MockInstance<typeof console.error>;
  exitSpy: MockInstance<typeof process.exit>;
}): void => {
  expect(consoleErrorSpy).toHaveBeenNthCalledWith(
    1,
    'Environment variables validation failed',
  );
  expect(consoleErrorSpy).toHaveBeenCalledTimes(2);
  expect(exitSpy).toHaveBeenCalledWith(1);
};

describe('node-server index entrypoint', () => {
  let exitSpy: MockInstance<typeof process.exit>;
  let consoleErrorSpy: MockInstance<typeof console.error>;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    setBundledRuntime(false);
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
    vi.stubEnv('PORT', '3000');

    exitSpy = vi.spyOn(process, 'exit');
    exitSpy.mockImplementation((code?: string | number | null) => {
      const formattedCode =
        code === null || code === undefined ? 'undefined' : String(code);
      throw new Error(
        `process.exit called unexpectedly with code ${formattedCode}`,
      );
    });
    consoleErrorSpy = vi.spyOn(console, 'error');
    consoleErrorSpy.mockImplementation(() => undefined);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  it('bootstraps express app when environment validation succeeds', async () => {
    // Arrange
    // Defaults from beforeEach ensure successful environment parsing

    // Act
    const module = await import('@/index');

    // Assert
    assertBootstrapSuccess({ module, exitSpy });
  });

  it('logs and exits when environment validation fails', async () => {
    // Arrange
    const exitError = new Error('process exit invoked');
    exitSpy.mockImplementationOnce((): never => {
      throw exitError;
    });

    environmentParseImpl.impl = (env): never => {
      void env;
      throw new ZodError([]);
    };

    // Act
    const importPromise = import('@/index');

    // Assert
    await expect(importPromise).rejects.toBe(exitError);

    assertBootstrapFailure({ consoleErrorSpy, exitSpy });
  });
});
