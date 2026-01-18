import {
  DescribeTableCommand,
  type DescribeTableCommandOutput,
  DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import {
  generateRequestHandler,
  type handlerInput,
  HTTP_RESPONSE,
  InternalServerError,
  LoggerService,
  type LoggerServiceSchema,
} from '@packages/backend-core';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { Effect, Layer } from 'effect';
import { Agent } from 'node:https';

import { usersTableName } from '@/clients/cdkOutputs';
import { ApplicationLoggerService } from '@/services/logger.service';

// Version is loaded from environment or package.json
const getVersion = (): string => {
  // Prefer environment variable (set at build/deploy time)
  if (process.env.APP_VERSION) {
    return process.env.APP_VERSION;
  }
  // Fall back to npm_package_version (available when running via npm scripts)
  if (process.env.npm_package_version) {
    return process.env.npm_package_version;
  }
  // Last resort: try to read package.json
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pkg = require('../../package.json') as { version: string };
    return pkg.version;
  } catch {
    return 'unknown';
  }
};

type HealthStatus = 'healthy' | 'degraded' | 'unhealthy';

type ComponentHealth = {
  readonly status: HealthStatus;
  readonly latencyMs?: number;
  readonly error?: string;
};

type HealthResponse = {
  readonly status: HealthStatus;
  readonly timestamp: string;
  readonly version: string;
  readonly components: {
    readonly dynamodb: ComponentHealth;
  };
};

const httpHandler = new NodeHttpHandler({
  connectionTimeout: 300,
  socketTimeout: 1000,
  requestTimeout: 1500,
  httpsAgent: new Agent({ keepAlive: true }),
});

const createDynamoDBClient = (): DynamoDBClient =>
  new DynamoDBClient({
    region: process.env.AWS_REGION,
    requestHandler: httpHandler,
    maxAttempts: 1,
  });

const checkDynamoDBHealth = (): Effect.Effect<ComponentHealth, never> => {
  return Effect.gen(function* () {
    const startTime = Date.now();

    const result = yield* Effect.tryPromise({
      try: async (): Promise<DescribeTableCommandOutput> => {
        const client = createDynamoDBClient();
        try {
          return await client.send(
            new DescribeTableCommand({
              TableName: usersTableName,
            }),
          );
        } finally {
          client.destroy();
        }
      },
      catch: (error): Error =>
        error instanceof Error ? error : new Error(String(error)),
    }).pipe(Effect.either);

    const latencyMs = Date.now() - startTime;

    if (result._tag === 'Left') {
      return {
        status: 'unhealthy' as const,
        latencyMs,
        error: result.left.message,
      };
    }

    const tableStatus = result.right.Table?.TableStatus;
    if (tableStatus !== 'ACTIVE') {
      return {
        status: 'degraded' as const,
        latencyMs,
        error: `Table status: ${tableStatus ?? 'unknown'}`,
      };
    }

    return {
      status: 'healthy' as const,
      latencyMs,
    };
  });
};

const determineOverallStatus = (
  dynamodbHealth: ComponentHealth,
): HealthStatus => {
  if (dynamodbHealth.status === 'unhealthy') {
    return 'unhealthy';
  }
  if (dynamodbHealth.status === 'degraded') {
    return 'degraded';
  }
  return 'healthy';
};

const healthHandler = (
  input: handlerInput,
): Effect.Effect<HealthResponse, InternalServerError, LoggerService> => {
  return Effect.gen(function* () {
    // Consume the input (even though we don't use request data)
    yield* input;
    const logger = yield* LoggerService;

    const dynamodbHealth = yield* checkDynamoDBHealth();

    const overallStatus = determineOverallStatus(dynamodbHealth);

    if (overallStatus !== 'healthy') {
      yield* logger.log(
        `Health check returned ${overallStatus}: DynamoDB=${dynamodbHealth.status}`,
      );
    }

    return {
      status: overallStatus,
      timestamp: new Date().toISOString(),
      version: getVersion(),
      components: {
        dynamodb: dynamodbHealth,
      },
    };
  });
};

const HealthLayer = ApplicationLoggerService;

export const healthRequestHandler = generateRequestHandler<
  HealthResponse,
  InternalServerError
>({
  effectfulHandler: (input) =>
    healthHandler(input).pipe(Effect.provide(HealthLayer)),
  shouldObfuscate: () => false,
  statusCodesToErrors: {
    [HTTP_RESPONSE.INTERNAL_SERVER_ERROR]: {
      errorType: InternalServerError,
      mapper: (error) => error.message,
    },
  },
  successCode: HTTP_RESPONSE.OK,
});

// Export for testing
export {
  checkDynamoDBHealth,
  determineOverallStatus,
  healthHandler,
  type ComponentHealth,
  type HealthResponse,
  type HealthStatus,
};
