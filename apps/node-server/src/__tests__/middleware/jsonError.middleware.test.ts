import { describe, expect, it } from 'vitest';

import { makeRequestContext } from '@/__tests__/utils/express';
import { jsonErrorMiddleware } from '@/middleware/jsonError.middleware';

describe('jsonErrorMiddleware', () => {
  it('responds with 400 when payload causes a SyntaxError carrying body', () => {
    const { req, res, next, captured } = makeRequestContext();
    const syntaxError = Object.assign(new SyntaxError('Unexpected token'), {
      body: '{}',
    });

    jsonErrorMiddleware(syntaxError, req, res, next);

    expect(captured.statusCode).toBe(400);
    expect(captured.jsonBody).toStrictEqual({ error: 'Invalid JSON' });
    expect(next).not.toHaveBeenCalled();
  });

  it('delegates to next for non-syntax errors', () => {
    const { req, res, next, captured } = makeRequestContext();
    const error = new Error('boom');

    jsonErrorMiddleware(error, req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith(error);
    expect(captured.statusCode).toBeUndefined();
    expect(captured.jsonBody).toBeUndefined();
  });
});
