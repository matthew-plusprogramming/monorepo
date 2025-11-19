import { HTTP_RESPONSE } from '@packages/backend-core';
import {
  makeRequestContext,
  setBundledRuntime,
} from '@packages/backend-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('__HANDLER_CAMEL__RequestHandler', () => {
  beforeEach(() => {
    vi.resetModules();
    setBundledRuntime(false);
  });

  it('returns 200 with the placeholder payload', async () => {
    // Arrange
    const { req, res, captured } = makeRequestContext({
      method: '__HTTP_METHOD__',
    });
    const { __HANDLER_CAMEL__RequestHandler } = await import(
      '@/handlers/__HANDLER_CAMEL__.handler'
    );

    // Act
    await __HANDLER_CAMEL__RequestHandler(req, res, vi.fn());

    // Assert
    expect(captured.statusCode).toBe(HTTP_RESPONSE.OK);
    expect(captured.sendBody).toStrictEqual({
      message: '__HANDLER_PASCAL__ handler response',
    });
  });
});

