import express from 'express';
import { prettifyError, ZodError } from 'zod';

import { parseIntRequestHandler } from './handlers/parseInt.handler';
import { jsonErrorMiddleware } from './middleware/jsonError.middleware';
import { EnvironmentSchema } from './types/environment';

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
app.use(express.json());
app.use(jsonErrorMiddleware);

app.post('/parse-int', parseIntRequestHandler);

app.listen(process.env.PORT);

export const viteNodeApp = app;
