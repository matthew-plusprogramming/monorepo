# @packages/backend-core

Effect-friendly primitives shared by the backend services (Express server + analytics lambda). Provides HTTP adapters, AWS service contexts, auth utilities, and testing fakes.

## Exports

- `generateRequestHandler` — Wrap an Effect-powered handler with Express, map domain errors to HTTP responses, and optionally obfuscate errors (see `src/request.handler.ts`).
- AWS service contexts — `DynamoDbService`, `EventBridgeService`, `LoggerService` tags plus schemas for effect environments (`src/services/**`).
- Auth helpers — JWT + role helpers under `@packages/backend-core/auth`.
- Types — HTTP/status enums and error types under `@packages/backend-core/types`.
- Testing — Fakes for DynamoDB/EventBridge/Logger plus runtime helpers under `@packages/backend-core/testing`.

## Usage

```ts
import { generateRequestHandler } from '@packages/backend-core';
import { DynamoDbService } from '@packages/backend-core';

const handler = generateRequestHandler({
  effectfulHandler: ({ body }) => /* Effect pipeline */,
  shouldObfuscate: () => false,
  statusCodesToErrors: {
    400: { errorType: BadRequestError, mapper: (error) => ({ message: error.message }) },
  },
  successCode: 200,
});

app.post('/example', handler);
```

Services can inject AWS clients via Effect layers bound to the exported context tags, and tests can swap them with fakes from the `testing` entrypoint.

## Scripts

- `build`: Compile TypeScript and rewrite paths with `tsc-alias`.
- `clean`: Remove `dist/`, `node_modules/`, and `.turbo`.
- `lint` / `lint:fix` / `lint:no-cache`: ESLint via the shared config.

Run scripts from the repo root with the workspace flag, e.g. `npm -w @packages/backend-core run build`.
