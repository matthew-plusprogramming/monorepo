import type { handlerInput } from '@packages/backend-core';
import { Effect } from 'effect';
import type { NextFunction, Request, Response } from 'express';
import { vi } from 'vitest';

type RequestContextInit = {
  headers?: Record<string, string | undefined>;
  body?: unknown;
  params?: Record<string, string>;
  query?: Record<string, unknown>;
  method?: string;
  url?: string;
  ip?: string;
};

type CapturedResponse = {
  statusCode?: number;
  jsonBody?: unknown;
  sendBody?: unknown;
};

type RunEffect = <R, E>(effect: Effect.Effect<R, E, never>) => Promise<R>;

type HandlerRunner = <R, E>(
  handler: (input: handlerInput) => Effect.Effect<R, E, never>,
) => Promise<R>;

export type RequestContext = {
  readonly req: Request & { user?: unknown };
  readonly res: Response;
  readonly next: NextFunction & ReturnType<typeof vi.fn>;
  readonly captured: CapturedResponse;
  readonly handlerInput: handlerInput;
  readonly runEffect: RunEffect;
  readonly runHandler: HandlerRunner;
  readonly reset: () => void;
};

const createRequest = (
  init: RequestContextInit,
): Request & { user?: unknown } => {
  const {
    headers = {},
    body,
    params = {},
    query = {},
    method = 'GET',
    url = '/',
    ip,
  } = init;

  const request = {
    headers,
    body,
    params,
    query,
    method,
    url,
  } as unknown as Request & { user?: unknown };

  if (ip) {
    Reflect.set(request, 'ip', ip);
  }

  return request;
};

type ResponseMock = ReturnType<typeof vi.fn>;

const createResponse = (
  captured: CapturedResponse,
): {
  response: Response;
  statusMock: ResponseMock;
  jsonMock: ResponseMock;
  sendMock: ResponseMock;
} => {
  const response = {} as Response;

  const statusMock: ResponseMock = vi.fn((statusCode: number) => {
    captured.statusCode = statusCode;
    return response;
  });

  const jsonMock: ResponseMock = vi.fn((payload: unknown) => {
    captured.jsonBody = payload;
    return response;
  });

  const sendMock: ResponseMock = vi.fn((payload: unknown) => {
    captured.sendBody = payload;
    return response;
  });

  Object.assign(response, {
    status: statusMock,
    json: jsonMock,
    send: sendMock,
  });

  return { response, statusMock, jsonMock, sendMock };
};

export const makeHandlerInput = (req: Request): handlerInput =>
  Effect.succeed(req) as handlerInput;

export const runEffect: RunEffect = async (effect) => Effect.runPromise(effect);

export const makeRequestContext = (
  init: RequestContextInit = {},
): RequestContext => {
  const captured: CapturedResponse = {};
  const req = createRequest(init);
  const handlerInputEffect = makeHandlerInput(req);
  const { response, statusMock, jsonMock, sendMock } = createResponse(captured);
  const next = vi.fn() as NextFunction & ReturnType<typeof vi.fn>;

  return {
    req,
    res: response,
    next,
    captured,
    handlerInput: handlerInputEffect,
    runEffect,
    runHandler: (handler) =>
      Effect.succeed(req).pipe(handler).pipe(Effect.runPromise),
    reset: (): void => {
      captured.statusCode = undefined;
      captured.jsonBody = undefined;
      captured.sendBody = undefined;
      statusMock.mockClear();
      jsonMock.mockClear();
      sendMock.mockClear();
      next.mockClear();
    },
  };
};
