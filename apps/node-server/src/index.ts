import { Effect } from 'effect';
import type { Handler } from 'express';
import express from 'express';

import { parseIntHandler } from './handlers/parseInt.handler';
import { jsonErrorMiddleware } from './middleware/jsonError.middleware';

const app = express();
app.use(express.json());
app.use(jsonErrorMiddleware);

const handleParseInt: Handler = async (req, res) => {
  const result = Effect.succeed(req)
    .pipe(parseIntHandler)
    .pipe(
      Effect.catchTag('ParseError', (error) => {
        console.error('Parse error:', error.message);
        return Effect.succeed(`Error: ${error.message}`);
      }),
    );

  res.send(Effect.runSync(result));
};

app.post('/parse-int', handleParseInt);

app.listen(process.env.PORT);

export const viteNodeApp = app;
