import { HTTP_RESPONSE } from '@packages/backend-core';
import {
  makeRequestContext,
  setBundledRuntime,
} from '@packages/backend-core/testing';
import type { RequestHandler } from 'express';
import type { Mock } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeCdkOutputsStub } from '@/__tests__/stubs/cdkOutputs';
import { clearAllRateLimits } from '@/middleware/dashboardRateLimiting.middleware';

type BcryptCompareFn = (
  password: string,
  hash: string,
) => Promise<boolean>;

type BcryptCompareMock = Mock<BcryptCompareFn>;

type DashboardLoginBody = {
  readonly password: string;
};

const bcryptModule = vi.hoisted((): { compare?: BcryptCompareMock } => ({}));

vi.mock('@/clients/cdkOutputs', () => makeCdkOutputsStub());

vi.mock('bcryptjs', () => {
  const compare = vi.fn<BcryptCompareFn>();
  bcryptModule.compare = compare;
  return {
    default: { compare },
    compare,
  };
});

const createLoginBody = ({
  password = 'test-password',
}: Partial<DashboardLoginBody> = {}): DashboardLoginBody => ({
  password,
});

const getCompareMock = (): BcryptCompareMock => {
  if (!bcryptModule.compare) {
    throw new Error('bcrypt compare mock was not initialized');
  }
  return bcryptModule.compare;
};

const importDashboardLoginHandler = async (): Promise<RequestHandler> => {
  const module = await import('@/handlers/dashboardLogin.handler');
  return module.dashboardLoginRequestHandler;
};

const createMockResponse = (): {
  statusCode?: number;
  sendBody?: unknown;
  cookies: Record<string, { value: string; options: Record<string, unknown> }>;
  res: {
    status: Mock;
    send: Mock;
    json: Mock;
    cookie: Mock;
  };
} => {
  const captured: {
    statusCode?: number;
    sendBody?: unknown;
    cookies: Record<string, { value: string; options: Record<string, unknown> }>;
  } = { cookies: {} };

  const res = {
    status: vi.fn((code: number) => {
      captured.statusCode = code;
      return res;
    }),
    send: vi.fn((body: unknown) => {
      captured.sendBody = body;
      return res;
    }),
    json: vi.fn((body: unknown) => {
      captured.sendBody = body;
      return res;
    }),
    cookie: vi.fn((name: string, value: string, options: Record<string, unknown>) => {
      captured.cookies[name] = { value, options };
      return res;
    }),
  };

  return { ...captured, res };
};

const initializeContext = (): void => {
  vi.resetModules();
  setBundledRuntime(false);
  vi.stubEnv('PASSWORD_HASH', '$2a$10$test-bcrypt-hash');
  vi.stubEnv('SESSION_SECRET', 'test-session-secret');
  vi.stubEnv('SESSION_EXPIRY_HOURS', '24');
  vi.stubEnv('APP_ENV', 'development');
  bcryptModule.compare?.mockReset();
  clearAllRateLimits();
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('dashboardLoginRequestHandler', () => {
  beforeEach(initializeContext);

  it('returns 200 and sets session cookie for valid password', async () => {
    // Arrange
    const body = createLoginBody();
    const { req, captured } = makeRequestContext({
      method: 'POST',
      url: '/api/auth/login',
      body,
    });
    const mockRes = createMockResponse();
    (req as unknown as { res: typeof mockRes.res }).res = mockRes.res;
    (req as unknown as { socket: { remoteAddress: string } }).socket = {
      remoteAddress: '127.0.0.1',
    };

    const handler = await importDashboardLoginHandler();
    const compareMock = getCompareMock();
    compareMock.mockResolvedValueOnce(true);

    // Act
    await handler(req, mockRes.res as never, vi.fn());

    // Assert
    expect(mockRes.res.status).toHaveBeenCalledWith(HTTP_RESPONSE.OK);
    expect(mockRes.cookies).toHaveProperty('dashboard_session');
    const sessionCookie = mockRes.cookies['dashboard_session']!;
    expect(sessionCookie.options.httpOnly).toBe(true);
    expect(sessionCookie.options.path).toBe('/');
  });

  it('returns 401 for invalid password', async () => {
    // Arrange
    const body = createLoginBody();
    const { req, captured } = makeRequestContext({
      method: 'POST',
      url: '/api/auth/login',
      body,
    });
    const mockRes = createMockResponse();
    (req as unknown as { res: typeof mockRes.res }).res = mockRes.res;

    const handler = await importDashboardLoginHandler();
    const compareMock = getCompareMock();
    compareMock.mockResolvedValueOnce(false);

    // Act
    await handler(req, mockRes.res as never, vi.fn());

    // Assert
    expect(mockRes.res.status).toHaveBeenCalledWith(HTTP_RESPONSE.UNAUTHORIZED);
  });

  it('returns 400 when password is missing', async () => {
    // Arrange
    const body = { password: '' };
    const { req, captured } = makeRequestContext({
      method: 'POST',
      url: '/api/auth/login',
      body,
    });
    const mockRes = createMockResponse();
    (req as unknown as { res: typeof mockRes.res }).res = mockRes.res;

    const handler = await importDashboardLoginHandler();

    // Act
    await handler(req, mockRes.res as never, vi.fn());

    // Assert
    expect(mockRes.res.status).toHaveBeenCalledWith(HTTP_RESPONSE.BAD_REQUEST);
  });

  it('returns 500 when bcrypt verification fails', async () => {
    // Arrange
    const body = createLoginBody();
    const { req, captured } = makeRequestContext({
      method: 'POST',
      url: '/api/auth/login',
      body,
    });
    const mockRes = createMockResponse();
    (req as unknown as { res: typeof mockRes.res }).res = mockRes.res;

    const handler = await importDashboardLoginHandler();
    const compareMock = getCompareMock();
    compareMock.mockRejectedValueOnce(new Error('bcrypt error'));

    // Act
    await handler(req, mockRes.res as never, vi.fn());

    // Assert
    expect(mockRes.res.status).toHaveBeenCalledWith(HTTP_RESPONSE.INTERNAL_SERVER_ERROR);
  });
});
