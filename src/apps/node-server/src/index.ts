import type { Handler } from 'express';
import express from 'express';

const app = express();

const handleRoot: Handler = (_, res) => {
  console.info('Received a request at /');
  console.info(`Defined env variable: ${__TEST_DEFINE__}`);
  res.send('Hello from Node.js server!');
};

app.get('/', handleRoot);

app.listen(__PORT__);

export const viteNodeApp = app;
