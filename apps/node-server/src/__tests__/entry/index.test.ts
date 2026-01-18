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
  put: ReturnType<typeof vi.fn>;
  patch: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
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
const cookieParserModule = vi.hoisted<SingleMockState>(() => ({
  handler: undefined,
}));
const loggingModule = vi.hoisted<{ middleware?: ReturnType<typeof vi.fn> }>(() => ({
  middleware: undefined,
}));
const ipRateLimitModule = vi.hoisted<SingleMockState>(() => ({
  handler: undefined,
}));
const jsonErrorModule = vi.hoisted<SingleMockState>(() => ({
  handler: undefined,
}));
const csrfModule = vi.hoisted<{
  tokenMiddleware?: ReturnType<typeof vi.fn>;
  validationMiddleware?: ReturnType<typeof vi.fn>;
}>(() => ({
  tokenMiddleware: undefined,
  validationMiddleware: undefined,
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
  const put = vi.fn();
  const patch = vi.fn();
  const del = vi.fn();
  const listen = vi.fn();
  const app: ExpressAppStub = { use, post, get, put, patch, delete: del, listen };
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

vi.mock('cookie-parser', () => {
  const handler = vi.fn();
  const factory = vi.fn(() => handler);
  cookieParserModule.handler = handler;
  return { default: factory };
});

vi.mock('@/middleware/logging.middleware', () => {
  const middleware = vi.fn();
  loggingModule.middleware = middleware;
  return {
    loggingMiddleware: middleware,
    loggingErrorMiddleware: vi.fn(),
  };
});

vi.mock('@/middleware/csrf.middleware', () => {
  const tokenMiddleware = vi.fn();
  const validationMiddleware = vi.fn();
  csrfModule.tokenMiddleware = tokenMiddleware;
  csrfModule.validationMiddleware = validationMiddleware;
  return {
    csrfTokenMiddleware: tokenMiddleware,
    csrfValidationMiddleware: validationMiddleware,
  };
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

const requireCookieParserMiddleware = (): ReturnType<typeof vi.fn> => {
  return ensureDefined(cookieParserModule.handler, 'cookie-parser middleware');
};

const requireLoggingMiddleware = (): ReturnType<typeof vi.fn> => {
  return ensureDefined(loggingModule.middleware, 'logging middleware');
};

const requireIpRateLimitMiddleware = (): ReturnType<typeof vi.fn> => {
  return ensureDefined(ipRateLimitModule.handler, 'ipRateLimiting middleware');
};

const requireJsonErrorMiddleware = (): ReturnType<typeof vi.fn> => {
  return ensureDefined(jsonErrorModule.handler, 'jsonError middleware');
};

const requireCsrfTokenMiddleware = (): ReturnType<typeof vi.fn> => {
  return ensureDefined(csrfModule.tokenMiddleware, 'csrf token middleware');
};

const requireCsrfValidationMiddleware = (): ReturnType<typeof vi.fn> => {
  return ensureDefined(csrfModule.validationMiddleware, 'csrf validation middleware');
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
  // Middleware order: cors, cookieParser, logging, ipRateLimit, express.json, jsonError, csrfToken, csrfValidation
  expect(expressApp.use).toHaveBeenNthCalledWith(1, requireCorsMiddleware());
  expect(expressApp.use).toHaveBeenNthCalledWith(2, requireCookieParserMiddleware());
  expect(expressApp.use).toHaveBeenNthCalledWith(3, requireLoggingMiddleware());
  expect(expressApp.use).toHaveBeenNthCalledWith(4, requireIpRateLimitMiddleware());
  expect(expressModule.json).toHaveBeenCalledTimes(1);
  expect(expressApp.use).toHaveBeenNthCalledWith(5, jsonMiddleware);
  expect(expressApp.use).toHaveBeenNthCalledWith(6, requireJsonErrorMiddleware());
  expect(expressApp.use).toHaveBeenNthCalledWith(7, requireCsrfTokenMiddleware());
  expect(expressApp.use).toHaveBeenNthCalledWith(8, requireCsrfValidationMiddleware());
  // Verify that routes are registered (checking one representative route)
  expect(expressApp.post).toHaveBeenCalled();
  expect(expressApp.get).toHaveBeenCalled();
  // Note: listen is not called directly on express app since we use http.createServer for WebSocket support
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

  it('rethrows non-Zod errors during environment validation', async () => {
    // Arrange
    const unexpected = new Error('unexpected failure');
    environmentParseImpl.impl = (): never => {
      throw unexpected;
    };

    // Act
    const importPromise = import('@/index');

    // Assert
    await expect(importPromise).rejects.toBe(unexpected);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });
});
