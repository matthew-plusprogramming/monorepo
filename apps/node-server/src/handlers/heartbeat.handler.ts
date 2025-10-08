import { HTTP_RESPONSE } from '@packages/backend-core';
import type { RequestHandler } from 'express';

export const heartbeatRequestHandler: RequestHandler = async (_req, res) => {
  return res.status(HTTP_RESPONSE.SUCCESS).send('OK');
};
