const NODE_SERVER_CDK_OUTPUTS_TEST = `import { API_STACK_NAME } from '@cdk/platform-cdk';
import {
  clearBundledRuntime,
  setBundledRuntime,
} from '@packages/backend-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type OutputsByStack = {
  [API_STACK_NAME]: {
    apiUserTableName: string;
    apiUserVerificationTableName: string;
    apiRateLimitTableName: string;
    apiDenyListTableName: string;
  };
};

type StackName = keyof OutputsByStack;

type LoadCall = {
  readonly stack: StackName;
  readonly basePath: string | undefined;
};

const { outputsByStack, loadCalls, loadCDKOutputMock } = vi.hoisted(() => {
  const outputsByStack = new Map<StackName, OutputsByStack[StackName]>();
  const loadCalls: Array<LoadCall> = [];

  const loadCDKOutputMock = vi.fn((stack: StackName, basePath?: string) => {
    loadCalls.push({ stack, basePath });
    const outputs = outputsByStack.get(stack);
    if (!outputs) {
      throw new Error(\`Missing outputs for stack \${stack}\`);
    }
    return outputs;
  });

  return {
    outputsByStack,
    loadCalls,
    loadCDKOutputMock,
  };
});

type PlatformCdkModule = Record<string, unknown> & {
  loadCDKOutput: (stack: string, basePath?: string) => unknown;
};

vi.mock('@cdk/platform-cdk', async () => {
  const actual = await vi.importActual('@cdk/platform-cdk');
  if (!isPlatformCdkModule(actual)) {
    throw new Error('Failed to load platform-cdk module');
  }

  const apiStackName = actual.API_STACK_NAME as StackName;
  outputsByStack.set(apiStackName, {
    apiUserTableName: 'users-table',
    apiUserVerificationTableName: 'verification-table',
    apiRateLimitTableName: 'rate-limit-table',
    apiDenyListTableName: 'deny-list-table',
  });

  return {
    ...actual,
    loadCDKOutput: loadCDKOutputMock,
  };
});

// Required to hoist before the mock factory runs
// eslint-disable-next-line func-style
function isPlatformCdkModule(value: unknown): value is PlatformCdkModule {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  if (!('loadCDKOutput' in value)) {
    return false;
  }
  const { loadCDKOutput } = value as { loadCDKOutput: unknown };
  return typeof loadCDKOutput === 'function';
}

describe('clients/cdkOutputs', () => {
  beforeEach(() => {
    loadCalls.length = 0;
    loadCDKOutputMock.mockClear();
  });

  afterEach(() => {
    clearBundledRuntime();
  });

  it('resolves outputs with default path when not bundled', async () => {
    // Arrange
    vi.resetModules();
    setBundledRuntime(false);

    // Act
    const module = await import('@/clients/cdkOutputs');

    // Assert
    expect(loadCalls).toEqual([{ stack: API_STACK_NAME, basePath: undefined }]);
    expect(module.usersTableName).toBe('users-table');
    expect(module.rateLimitTableName).toBe('rate-limit-table');
    expect(module.denyListTableName).toBe('deny-list-table');
  });

  it('uses bundled base path when __BUNDLED__ is true', async () => {
    // Arrange
    vi.resetModules();
    setBundledRuntime(true);

    // Act
    const module = await import('@/clients/cdkOutputs');

    // Assert
    expect(loadCalls).toEqual([{ stack: API_STACK_NAME, basePath: '.' }]);
    expect(module.usersTableName).toBe('users-table');
    expect(module.rateLimitTableName).toBe('rate-limit-table');
    expect(module.denyListTableName).toBe('deny-list-table');
  });
});
`;

const NODE_SERVER_APP_LAYER_TEST = `import {
  DynamoDbService,
  LoggerService,
} from '@packages/backend-core';
import {
  type DynamoDbServiceFake,
  type LoggerServiceFake,
  setBundledRuntime,
} from '@packages/backend-core/testing';
import { Effect, Layer, Option } from 'effect';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeCdkOutputsStub } from '@/__tests__/stubs/cdkOutputs';
import type * as DynamoServiceModule from '@/services/dynamodb.service';
import type * as LoggerServiceModule from '@/services/logger.service';
import type * as UserRepoModule from '@/services/userRepo.service';
import type { UserRepoSchema } from '@/services/userRepo.service';

const dynamoModule = vi.hoisted((): { fake?: DynamoDbServiceFake } => ({}));
const loggerModule = vi.hoisted((): { fake?: LoggerServiceFake } => ({}));
const userRepoModule = vi.hoisted((): { service?: UserRepoSchema } => ({}));

vi.mock('@/clients/cdkOutputs', () => makeCdkOutputsStub());

vi.mock('@/services/dynamodb.service', async (importOriginal) => {
  const actual: typeof DynamoServiceModule = await importOriginal();
  const { createDynamoDbServiceFake } =
    await import('@packages/backend-core/testing');
  const fake = createDynamoDbServiceFake();
  dynamoModule.fake = fake;
  return {
    ...actual,
    LiveDynamoDbService: fake.layer,
  } satisfies typeof actual;
});

vi.mock('@/services/logger.service', async (importOriginal) => {
  const actual: typeof LoggerServiceModule = await importOriginal();
  const { createLoggerServiceFake } =
    await import('@packages/backend-core/testing');
  const fake = createLoggerServiceFake();
  loggerModule.fake = fake;
  return {
    ...actual,
    ApplicationLoggerService: fake.layer,
    SecurityLoggerService: fake.layer,
  } satisfies typeof actual;
});

vi.mock('@/services/userRepo.service', async (importOriginal) => {
  const actual: typeof UserRepoModule = await importOriginal();
  const service: UserRepoSchema = {
    findByIdentifier: vi.fn(() => Effect.succeed(Option.none())),
    findCredentialsByIdentifier: vi.fn(() => Effect.succeed(Option.none())),
    create: vi.fn(() => Effect.succeed(true as const)),
  };
  userRepoModule.service = service;
  return {
    ...actual,
    LiveUserRepo: Layer.succeed(actual.UserRepo, service),
  } satisfies typeof actual;
});

const getDynamoFake = (): DynamoDbServiceFake => {
  if (!dynamoModule.fake) {
    throw new Error('Dynamo fake was not initialized');
  }
  return dynamoModule.fake;
};

const getLoggerFake = (): LoggerServiceFake => {
  if (!loggerModule.fake) {
    throw new Error('Logger fake was not initialized');
  }
  return loggerModule.fake;
};

const getUserRepoService = (): UserRepoSchema => {
  if (!userRepoModule.service) {
    throw new Error('User repo service was not initialized');
  }
  return userRepoModule.service;
};

describe('AppLayer', () => {
  beforeEach(() => {
    vi.resetModules();
    setBundledRuntime(false);
  });

  it('provides DynamoDb, Logger, and UserRepo services', async () => {
    // Arrange
    const { AppLayer } = await import('@/layers/app.layer');
    const { UserRepo } = await import('@/services/userRepo.service');

    // Act
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const dynamo = yield* DynamoDbService;
        const logger = yield* LoggerService;
        const repo = yield* UserRepo;
        return { dynamo, logger, repo };
      }).pipe(Effect.provide(AppLayer)),
    );

    // Assert
    expect(result.dynamo).toBe(getDynamoFake().service);
    expect(result.logger).toBe(getLoggerFake().service);
    expect(result.repo).toBe(getUserRepoService());
  });
});
`;

const NODE_SERVER_LAMBDA_TEST = `import { setBundledRuntime } from '@packages/backend-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ensureDefined } from '@/__tests__/utils/ensureDefined';

type ExpressAppStub = {
  use: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  listen: ReturnType<typeof vi.fn>;
};

type MockFn = ReturnType<typeof vi.fn>;

type ExpressModuleState = {
  app: ExpressAppStub | undefined;
  factory: MockFn | undefined;
  json: MockFn | undefined;
  jsonMiddleware: MockFn | undefined;
  use: MockFn | undefined;
  post: MockFn | undefined;
  get: MockFn | undefined;
  listen: MockFn | undefined;
};

type SingleMockState = {
  handler: MockFn | undefined;
};

type EnvironmentModuleState = {
  parse: MockFn | undefined;
};

type ServerlessModuleState = {
  factory: MockFn | undefined;
};

const expressModule = vi.hoisted<ExpressModuleState>(() => ({
  app: undefined,
  factory: undefined,
  json: undefined,
  jsonMiddleware: undefined,
  use: undefined,
  post: undefined,
  get: undefined,
  listen: undefined,
}));

const corsModule = vi.hoisted<SingleMockState>(() => ({
  handler: undefined,
}));
const ipRateLimitModule = vi.hoisted<SingleMockState>(() => ({
  handler: undefined,
}));
const jsonErrorModule = vi.hoisted<SingleMockState>(() => ({
  handler: undefined,
}));
const registerModule = vi.hoisted<SingleMockState>(() => ({
  handler: undefined,
}));
const getUserModule = vi.hoisted<SingleMockState>(() => ({
  handler: undefined,
}));
const environmentModule = vi.hoisted<EnvironmentModuleState>(() => ({
  parse: undefined,
}));
const serverlessModule = vi.hoisted<ServerlessModuleState>(() => ({
  factory: undefined,
}));

const handlerStub = { type: 'lambda-handler' } as const;

vi.mock('@dotenvx/dotenvx/config', () => ({}));

vi.mock('express', () => {
  const use = vi.fn();
  const post = vi.fn();
  const get = vi.fn();
  const listen = vi.fn();
  const app: ExpressAppStub = { use, post, get, listen };
  const jsonMiddleware = vi.fn();
  const json = vi.fn(() => jsonMiddleware);
  const factory = vi.fn(() => app);
  Object.assign(factory, { json });

  expressModule.app = app;
  expressModule.factory = factory;
  expressModule.json = json;
  expressModule.jsonMiddleware = jsonMiddleware;
  expressModule.use = use;
  expressModule.post = post;
  expressModule.get = get;
  expressModule.listen = listen;

  return { default: factory };
});

vi.mock('serverless-http', () => {
  const serverless = vi.fn(() => handlerStub);
  serverlessModule.factory = serverless;
  return { default: serverless };
});

vi.mock('cors', () => {
  const handler = vi.fn();
  const factory = vi.fn(() => handler);
  corsModule.handler = handler;
  return { default: factory };
});

vi.mock('@/middleware/ipRateLimiting.middleware', () => {
  const handler = vi.fn();
  ipRateLimitModule.handler = handler;
  return { ipRateLimitingMiddlewareRequestHandler: handler };
});

vi.mock('@/middleware/jsonError.middleware', () => {
  const handler = vi.fn();
  jsonErrorModule.handler = handler;
  return { jsonErrorMiddleware: handler };
});

vi.mock('@/handlers/register.handler', () => {
  const handler = vi.fn();
  registerModule.handler = handler;
  return { registerRequestHandler: handler };
});

vi.mock('@/handlers/getUser.handler', () => {
  const handler = vi.fn();
  getUserModule.handler = handler;
  return { getUserRequestHandler: handler };
});

vi.mock('@/types/environment', () => {
  const parse = vi.fn();
  environmentModule.parse = parse;
  return { EnvironmentSchema: { parse } };
});

const requireExpressApp = (): ExpressAppStub => {
  return ensureDefined(expressModule.app, 'express app');
};

const requireServerless = (): MockFn => {
  return ensureDefined(serverlessModule.factory, 'serverless-http mock');
};

const requireEnvironmentParse = (): MockFn => {
  return ensureDefined(environmentModule.parse, 'EnvironmentSchema.parse mock');
};

const requireCorsMiddleware = (): ReturnType<typeof vi.fn> => {
  return ensureDefined(corsModule.handler, 'cors middleware');
};

const requireIpRateLimitMiddleware = (): MockFn => {
  return ensureDefined(ipRateLimitModule.handler, 'ipRateLimiting middleware');
};

const requireJsonErrorMiddleware = (): MockFn => {
  return ensureDefined(jsonErrorModule.handler, 'jsonError middleware');
};

const requireRegisterHandler = (): MockFn => {
  return ensureDefined(registerModule.handler, 'register handler');
};

const requireGetUserHandler = (): MockFn => {
  return ensureDefined(getUserModule.handler, 'getUser handler');
};

const requireJsonMiddleware = (): MockFn => {
  return ensureDefined(expressModule.jsonMiddleware, 'express.json middleware');
};

describe('lambda entrypoint', () => {
  beforeEach(() => {
    vi.resetModules();
    setBundledRuntime(false);
  });

  it('wraps the Express app with serverless-http and exports the handler', async () => {
    // Arrange
    // Default mocks wired in module scope establish expectations

    // Act
    const module = await import('@/lambda');

    // Assert
    const expressApp = requireExpressApp();
    const serverless = requireServerless();
    const envParse = requireEnvironmentParse();

    expect(expressModule.factory).toHaveBeenCalledTimes(1);
    expect(envParse).toHaveBeenCalledWith(process.env);
    expect(expressModule.json).toHaveBeenCalledTimes(1);

    expect(expressApp.use).toHaveBeenNthCalledWith(1, requireCorsMiddleware());
    expect(expressApp.use).toHaveBeenNthCalledWith(
      2,
      requireIpRateLimitMiddleware(),
    );
    expect(expressApp.use).toHaveBeenNthCalledWith(3, requireJsonMiddleware());
    expect(expressApp.use).toHaveBeenNthCalledWith(
      4,
      requireJsonErrorMiddleware(),
    );

    expect(expressApp.post).toHaveBeenCalledWith(
      '/register',
      requireRegisterHandler(),
    );
    expect(expressApp.get).toHaveBeenCalledWith(
      '/user/:identifier',
      requireGetUserHandler(),
    );
    expect(expressApp.listen).toHaveBeenCalledWith(undefined);

    expect(serverless).toHaveBeenCalledTimes(1);
    expect(serverless).toHaveBeenCalledWith(expressApp);
    expect(module.handler).toBe(handlerStub);
  });
});
`;

const NODE_SERVER_CDK_OUTPUTS_STUB = `const DEFAULT_CDK_OUTPUTS = {
  rateLimitTableName: 'rate-limit-table',
  denyListTableName: 'deny-list-table',
  usersTableName: 'users-table',
  trackingEntriesTableName: 'tracking-entries-table',
  trackingEntriesUserGsiName: 'tracking-entries-gsi-user',
  trackingEntriesDeviceGsiName: 'tracking-entries-gsi-device',
};

export type CdkOutputsStub = typeof DEFAULT_CDK_OUTPUTS;

export const makeCdkOutputsStub = (
  overrides: Partial<CdkOutputsStub> = {},
): CdkOutputsStub => ({
  ...DEFAULT_CDK_OUTPUTS,
  ...overrides,
});
`;

export const removeHeartbeatFromServerIndex = (content) => {
  let updated = content;
  updated = updated.replace(
    /^\s*import\s+\{\s*heartbeatRequestHandler\s*\}\s+from\s+['"]@\/handlers\/heartbeat\.handler['"];?\n/m,
    '',
  );
  updated = updated.replace(
    /^\s*import\s+\{\s*isAuthenticatedMiddlewareRequestHandler\s*\}\s+from\s+['"]@\/middleware\/isAuthenticated\.middleware['"];?\n/m,
    '',
  );
  updated = updated.replace(
    /\napp\.get\(\s*\n\s*['"]\/heartbeat['"][\s\S]*?\);\n/m,
    '\n',
  );
  return updated;
};

export const stripAnalyticsFromNodeCdkOutputs = (content) => {
  let updated = content;
  updated = updated.replace(
    /import\s*\{[\s\S]*?\}\s*from\s*'@cdk\/platform-cdk';\n/,
    "import { API_STACK_NAME, loadCDKOutput } from '@cdk/platform-cdk';\n",
  );
  updated = updated.replace(/\nconst analyticsOutput[\s\S]*$/m, '\n');
  return updated;
};

export const stripEventBridgeFromAppLayer = (content) => {
  let updated = content;
  updated = updated.replace(
    /^\s*import\s+\{\s*LiveEventBridgeService\s*\}\s+from\s+['"]@\/services\/eventBridge\.service['"];?\n/m,
    '',
  );
  updated = updated.replace(/\.pipe\(Layer\.merge\(LiveEventBridgeService\)\)/g, '');
  return updated;
};

export const stripEventBridgeDependencyFromNodeServerPackage = (content) => {
  const json = JSON.parse(content);
  if (json.dependencies?.['@aws-sdk/client-eventbridge']) {
    delete json.dependencies['@aws-sdk/client-eventbridge'];
  }
  return `${JSON.stringify(json, null, 2)}\n`;
};

export const stripAnalyticsFromPlatformStacks = (content) => {
  let updated = content;
  updated = updated.replace(
    /import\s*\{[\s\S]*?\}\s*from\s*'\.\/consumer\/output';\n/m,
    "import {\n  ApiLambdaStackOutputSchema,\n  ApiStackOutputSchema,\n} from './consumer/output';\n",
  );
  updated = updated.replace(
    /^\s*import\s+\{\s*AnalyticsLambdaStack\s*\}.*\n/m,
    '',
  );
  updated = updated.replace(
    /^\s*import\s+\{\s*AnalyticsStack\s*\}.*\n/m,
    '',
  );
  updated = updated.replace(
    /import\s*\{[\s\S]*?\}\s*from\s*'\.\/stacks\/names';\n/m,
    "import {\n  API_LAMBDA_STACK_NAME,\n  API_STACK_NAME,\n  BOOTSTRAP_STACK_NAME,\n} from './stacks/names';\n",
  );
  updated = updated.replace(
    /\n\s*\{\n\s*name:\s*ANALYTICS_LAMBDA_STACK_NAME[\s\S]*?\n\s*\},/m,
    '',
  );
  updated = updated.replace(
    /\n\s*\{\n\s*name:\s*ANALYTICS_STACK_NAME[\s\S]*?\n\s*\},?/m,
    '',
  );
  return updated;
};

export const stripAnalyticsStackNamesFromPlatformNames = (content) => {
  const filtered = content
    .split('\n')
    .filter(
      (line) =>
        !line.includes('ANALYTICS_LAMBDA_STACK_NAME') &&
        !line.includes('ANALYTICS_STACK_NAME'),
    );
  return `${filtered.join('\n').trimEnd()}\n`;
};

export const stripAnalyticsExportsFromOutputIndex = (content) => {
  const filtered = content
    .split('\n')
    .filter((line) => !line.includes('analytics-'));
  return `${filtered.join('\n').trimEnd()}\n`;
};

export const stripAnalyticsPermissionsFromApiLambda = (content) => {
  let updated = content;
  updated = updated.replace(
    /^\s*import\s+\{\s*DataAwsCallerIdentity\s*\}.*\n/m,
    '',
  );
  updated = updated.replace(/^\s*import\s+\{\s*IamPolicy\s*\}.*\n/m, '');
  updated = updated.replace(
    /^\s*import\s+\{\s*ANALYTICS_EVENT_BUS_NAME\s*\}.*\n/m,
    '',
  );
  updated = updated.replace(
    /\nconst createAnalyticsPolicy[\s\S]*?\n};\n\n/m,
    '\n',
  );
  updated = updated.replace(/^\s*putEventsPolicy: IamPolicy,\n/m, '');
  updated = updated.replace(
    /\n\s*new IamRolePolicyAttachment\([\s\S]*?attach-put-events-policy[\s\S]*?\);\n/m,
    '\n',
  );
  updated = updated.replace(
    /\n\s*const callerIdentity = new DataAwsCallerIdentity\([\s\S]*?\);\n/m,
    '\n',
  );
  updated = updated.replace(
    /^\s*const putEventsPolicy = createAnalyticsPolicy.*\n/m,
    '',
  );
  updated = updated.replace(
    /createExecutionRole\(scope, assumeRole, putEventsPolicy\)/g,
    'createExecutionRole(scope, assumeRole)',
  );
  return updated;
};

export const stripAnalyticsFromSequencesConfig = (content) => {
  const json = JSON.parse(content);
  if (Array.isArray(json.sequences)) {
    json.sequences = json.sequences.map((sequence) => ({
      ...sequence,
      steps: Array.isArray(sequence.steps)
        ? sequence.steps.filter((step) => !/analytics-stack/i.test(step))
        : sequence.steps,
    }));
  }
  return `${JSON.stringify(json, null, 2)}\n`;
};

export const stripAnalyticsFromScriptsMd = (content) => {
  const filtered = content
    .split('\n')
    .filter((line) => !line.includes('myapp-analytics-stack'));
  return `${filtered.join('\n').trimEnd()}\n`;
};

export const stripAnalyticsFromRootReadme = (content) => {
  let updated = content.replace(
    /, EventBridge\/DynamoDB analytics processing, and /,
    ', ',
  );
  const filtered = updated
    .split('\n')
    .filter(
      (line) =>
        !line.includes('Analytics stack') &&
        !line.includes('analytics-stack') &&
        !line.includes('analytics-lambda'),
    );
  return `${filtered.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
};

export const stripAnalyticsFromNodeServerReadme = (content) => {
  const filtered = content
    .split('\n')
    .filter(
      (line) =>
        !/heartbeat/i.test(line) &&
        !/analytics-stack/i.test(line) &&
        !/analytics lambda/i.test(line),
    );
  return `${filtered.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
};

export const stripAnalyticsFromPlatformReadme = (content) => {
  let updated = content.replace('and analytics permissions', '');
  const filtered = updated
    .split('\n')
    .filter((line) => !/analytics-stack/i.test(line));
  return `${filtered.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
};

export const rewriteNodeServerCdkOutputsTest = () => NODE_SERVER_CDK_OUTPUTS_TEST;
export const rewriteNodeServerAppLayerTest = () => NODE_SERVER_APP_LAYER_TEST;
export const rewriteNodeServerLambdaTest = () => NODE_SERVER_LAMBDA_TEST;
export const rewriteNodeServerCdkOutputsStub = () => NODE_SERVER_CDK_OUTPUTS_STUB;

const analyticsAspect = {
  slug: 'analytics',
  description:
    'Removes analytics pipeline (heartbeat route, EventBridge adapter, analytics lambda, and CDK analytics stacks).',
  deletePaths: [
    'apps/analytics-lambda',
    'apps/node-server/src/handlers/heartbeat.handler.ts',
    'apps/node-server/src/services/eventBridge.service.ts',
    'apps/node-server/src/__tests__/handlers/heartbeat.handler.test.ts',
    'apps/node-server/src/__tests__/integration/express.integration.test.ts',
    'apps/node-server/src/__tests__/services/eventBridge.service.test.ts',
    'cdk/platform-cdk/src/stacks/analytics-stack',
    'cdk/platform-cdk/src/stacks/analytics-lambda-stack',
    'cdk/platform-cdk/src/consumer/output/analytics-stack-output.ts',
    'cdk/platform-cdk/src/consumer/output/analytics-lambda-stack-output.ts',
  ],
  fileEdits: [
    {
      path: 'apps/node-server/src/index.ts',
      transform: removeHeartbeatFromServerIndex,
    },
    {
      path: 'apps/node-server/src/clients/cdkOutputs.ts',
      transform: stripAnalyticsFromNodeCdkOutputs,
    },
    {
      path: 'apps/node-server/src/layers/app.layer.ts',
      transform: stripEventBridgeFromAppLayer,
    },
    {
      path: 'apps/node-server/package.json',
      transform: stripEventBridgeDependencyFromNodeServerPackage,
    },
    {
      path: 'apps/node-server/src/__tests__/clients/cdkOutputs.test.ts',
      transform: rewriteNodeServerCdkOutputsTest,
    },
    {
      path: 'apps/node-server/src/__tests__/layers/app.layer.test.ts',
      transform: rewriteNodeServerAppLayerTest,
    },
    {
      path: 'apps/node-server/src/__tests__/entry/lambda.test.ts',
      transform: rewriteNodeServerLambdaTest,
    },
    {
      path: 'apps/node-server/src/__tests__/stubs/cdkOutputs.ts',
      transform: rewriteNodeServerCdkOutputsStub,
    },
    {
      path: 'cdk/platform-cdk/src/stacks.ts',
      transform: stripAnalyticsFromPlatformStacks,
    },
    {
      path: 'cdk/platform-cdk/src/stacks/names.ts',
      transform: stripAnalyticsStackNamesFromPlatformNames,
    },
    {
      path: 'cdk/platform-cdk/src/stacks/api-lambda-stack/generate-api-lambda.ts',
      transform: stripAnalyticsPermissionsFromApiLambda,
    },
    {
      path: 'cdk/platform-cdk/src/consumer/output/index.ts',
      transform: stripAnalyticsExportsFromOutputIndex,
    },
    {
      path: 'scripts/sequences.config.json',
      transform: stripAnalyticsFromSequencesConfig,
    },
    {
      path: 'scripts.md',
      transform: stripAnalyticsFromScriptsMd,
    },
    {
      path: 'README.md',
      transform: stripAnalyticsFromRootReadme,
    },
    {
      path: 'apps/node-server/README.md',
      transform: stripAnalyticsFromNodeServerReadme,
    },
    {
      path: 'cdk/platform-cdk/README.md',
      transform: stripAnalyticsFromPlatformReadme,
    },
  ],
  notes: [
    'Run `npm install` after ejection to prune dependencies.',
    'Regenerate CDK outputs as needed for remaining stacks.',
  ],
};

export default analyticsAspect;
