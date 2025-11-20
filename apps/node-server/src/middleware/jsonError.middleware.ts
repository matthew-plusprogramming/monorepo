import { HTTP_RESPONSE } from '@packages/backend-core';
import type { ErrorRequestHandler } from 'express';

export const jsonErrorMiddleware: ErrorRequestHandler = (
  err,
  _req,
  res,
  next,
) => {
  if (err instanceof SyntaxError && 'body' in err) {
    res.status(HTTP_RESPONSE.BAD_REQUEST).json({ error: 'Invalid JSON' });
    return;
  }
  next(err);
};
