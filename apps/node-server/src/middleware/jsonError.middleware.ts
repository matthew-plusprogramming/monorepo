import type { ErrorRequestHandler } from 'express';

export const jsonErrorMiddleware: ErrorRequestHandler = (
  err,
  _req,
  res,
  next,
) => {
  if (err instanceof SyntaxError && 'body' in err) {
    res.status(400).json({ error: 'Invalid JSON' });
    return;
  }
  next(err);
};
