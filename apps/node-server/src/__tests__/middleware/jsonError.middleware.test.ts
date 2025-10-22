import { makeRequestContext } from '@packages/backend-core/testing';
import { describe, expect, it } from 'vitest';

import { jsonErrorMiddleware } from '@/middleware/jsonError.middleware';

describe('jsonErrorMiddleware', () => {
  it('responds with 400 when payload causes a SyntaxError carrying body', () => {
    // Arrange
    const { req, res, next, captured } = makeRequestContext();
    const syntaxError = Object.assign(new SyntaxError('Unexpected token'), {
      body: '{}',
    });

    // Act
    jsonErrorMiddleware(syntaxError, req, res, next);

    // Assert
    expect(captured.statusCode).toBe(400);
    expect(captured.jsonBody).toStrictEqual({ error: 'Invalid JSON' });
    expect(next).not.toHaveBeenCalled();
  });

  it('delegates to next for non-syntax errors', () => {
    // Arrange
    const { req, res, next, captured } = makeRequestContext();
    const error = new Error('boom');

    // Act
    jsonErrorMiddleware(error, req, res, next);

    // Assert
    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith(error);
    expect(captured.statusCode).toBeUndefined();
    expect(captured.jsonBody).toBeUndefined();
  });
});
