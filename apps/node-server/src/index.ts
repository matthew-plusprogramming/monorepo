import '@dotenvx/dotenvx/config';

import { setDefaultLayer } from '@packages/backend-core';
import express from 'express';
import { prettifyError, ZodError } from 'zod';

import { getUserRequestHandler } from '@/handlers/getUser.handler';
import { registerRequestHandler } from '@/handlers/register.handler';
import { AppLayer } from '@/layers/app.layer';
import { ipRateLimitingMiddlewareRequestHandler } from '@/middleware/ipRateLimiting.middleware';
import { jsonErrorMiddleware } from '@/middleware/jsonError.middleware';
import { EnvironmentSchema } from '@/types/environment';

try {
  EnvironmentSchema.parse(process.env);
} catch (error) {
  if (error instanceof ZodError) {
    console.error('Environment variables validation failed');
    console.error(prettifyError(error));
    process.exit(1);
  } else {
    throw error;
  }
}

const app = express();
setDefaultLayer(AppLayer);
app.use(ipRateLimitingMiddlewareRequestHandler);
app.use(express.json());
app.use(jsonErrorMiddleware);

app.post('/register', registerRequestHandler);
app.get('/user/:identifier', getUserRequestHandler);

app.listen(process.env.PORT);

export { app };
