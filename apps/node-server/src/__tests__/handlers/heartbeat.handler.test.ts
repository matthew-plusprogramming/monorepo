import { HTTP_RESPONSE } from '@packages/backend-core';
import {
  clearBundledRuntime,
  type DynamoDbServiceFake,
  type EventBridgeServiceFake,
  type LoggerServiceFake,
  setBundledRuntime,
} from '@packages/backend-core/testing';
import express, {
  type NextFunction,
  type Request,
  type Response as ExpressResponse,
} from 'express';
import request, { type Response } from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UserRepoFake } from '@/__tests__/fakes/userRepo';
import { makeCdkOutputsStub } from '@/__tests__/stubs/cdkOutputs';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const dynamoModule = vi.hoisted((): { fake?: DynamoDbServiceFake } => ({}));
const eventBridgeModule = vi.hoisted(
  (): { fake?: EventBridgeServiceFake } => ({}),
);
const loggerModule = vi.hoisted((): { fake?: LoggerServiceFake } => ({}));
const userRepoModule = vi.hoisted((): { fake?: UserRepoFake } => ({}));

vi.mock('@/clients/cdkOutputs', () => makeCdkOutputsStub());

vi.mock('@/layers/app.layer', async () => {
  const { Layer } = await import('effect');
  const {
    createDynamoDbServiceFake,
    createEventBridgeServiceFake,
    createLoggerServiceFake,
  } = await import('@packages/backend-core/testing');
  const { createUserRepoFake } = await import('@/__tests__/fakes/userRepo');

  const dynamoFake = createDynamoDbServiceFake();
  const eventBridgeFake = createEventBridgeServiceFake();
  const loggerFake = createLoggerServiceFake();
  const userRepoFake = createUserRepoFake();

  dynamoModule.fake = dynamoFake;
  eventBridgeModule.fake = eventBridgeFake;
  loggerModule.fake = loggerFake;
  userRepoModule.fake = userRepoFake;

  const AppLayer = Layer.mergeAll(
    dynamoFake.layer,
    loggerFake.layer,
    eventBridgeFake.layer,
    userRepoFake.layer,
  );

  return { AppLayer };
});

const getDynamoFake = (): DynamoDbServiceFake => {
  if (!dynamoModule.fake) {
    throw new Error('Dynamo fake was not initialized');
  }
  return dynamoModule.fake;
};

const getEventBridgeFake = (): EventBridgeServiceFake => {
  if (!eventBridgeModule.fake) {
    throw new Error('EventBridge fake was not initialized');
  }
  return eventBridgeModule.fake;
};

const getLoggerFake = (): LoggerServiceFake => {
  if (!loggerModule.fake) {
    throw new Error('Logger fake was not initialized');
  }
  return loggerModule.fake;
};

const getUserRepoFake = (): UserRepoFake => {
  if (!userRepoModule.fake) {
    throw new Error('User repo fake was not initialized');
  }
  return userRepoModule.fake;
};

const resetHeartbeatFakes = (
  eventBridgeFake: EventBridgeServiceFake,
  loggerFake: LoggerServiceFake,
): void => {
  eventBridgeFake.reset();
  loggerFake.reset();
  getDynamoFake().reset();
  getUserRepoFake().reset();
};

const attachUser = (user: { sub: string; jti: string }) => {
  return (req: Request, _res: ExpressResponse, next: NextFunction): void => {
    Object.assign(req, { user });
    next();
  };
};

const runHeartbeatScenario = async ({
  user,
  platform,
  configureEventBridge,
}: HeartbeatScenarioOptions): Promise<HeartbeatScenarioResult> => {
  const { heartbeatRequestHandler } = await import(
    '@/handlers/heartbeat.handler'
  );
  const eventBridgeFake = getEventBridgeFake();
  const loggerFake = getLoggerFake();

  resetHeartbeatFakes(eventBridgeFake, loggerFake);
  configureEventBridge(eventBridgeFake);

  const app = express();
  if (user) {
    app.get('/heartbeat', attachUser(user), heartbeatRequestHandler);
  } else {
    app.get('/heartbeat', heartbeatRequestHandler);
  }

  const httpRequest = request(app).get('/heartbeat');
  if (platform) {
    httpRequest.set('X-Platform', platform);
  }

  const response = await httpRequest;

  return { response, eventBridgeFake, loggerFake };
};

type HeartbeatScenarioOptions = {
  readonly user?: { sub: string; jti: string };
  readonly platform?: string;
  readonly configureEventBridge: (fake: EventBridgeServiceFake) => void;
};

type HeartbeatScenarioResult = {
  response: Response;
  eventBridgeFake: EventBridgeServiceFake;
  loggerFake: LoggerServiceFake;
};

const surfacesFailedEntriesWhenAuthenticated = async (): Promise<void> => {
  // Arrange
  const scenario: HeartbeatScenarioOptions = {
    user: { sub: 'user-3', jti: 'token-3' },
    configureEventBridge: (fake) => {
      fake.queueSuccess({
        $metadata: { httpStatusCode: 200 },
        FailedEntryCount: 1,
        Entries: [
          {
            ErrorCode: 'InternalFailure',
            ErrorMessage: 'Bus throttled',
          },
        ],
      });
    },
  };

  // Act
  const { response, eventBridgeFake, loggerFake } =
    await runHeartbeatScenario(scenario);

  // Assert
  expect(response.status).toBe(HTTP_RESPONSE.INTERNAL_SERVER_ERROR);
  expect(response.text).toBe('Failed to publish heartbeat analytics event');
  expect(eventBridgeFake.calls).toHaveLength(1);
  expect(loggerFake.entries.logs).toHaveLength(0);
  const errorArgs = loggerFake.entries.errors[0] ?? [];
  const firstError = errorArgs[0];
  expect(firstError).toBeInstanceOf(Error);
  if (firstError instanceof Error) {
    expect(firstError.message).toContain('InternalFailure');
  }
};

const surfacesPublishErrorsWhenAuthenticated = async (): Promise<void> => {
  // Arrange
  const scenario: HeartbeatScenarioOptions = {
    user: { sub: 'user-2', jti: 'token-2' },
    configureEventBridge: (fake) => {
      fake.queueFailure(new Error('boom'));
    },
  };

  // Act
  const { response, loggerFake } = await runHeartbeatScenario(scenario);

  // Assert
  expect(response.status).toBe(HTTP_RESPONSE.INTERNAL_SERVER_ERROR);
  expect(response.text).toBe('Failed to publish heartbeat analytics event');
  expect(loggerFake.entries.errors).toHaveLength(1);
};

const surfacesFailuresWithoutEntryDetails = async (): Promise<void> => {
  // Arrange
  const scenario: HeartbeatScenarioOptions = {
    user: { sub: 'user-6', jti: 'token-6' },
    configureEventBridge: (fake) => {
      fake.queueSuccess({
        $metadata: { httpStatusCode: 200 },
        FailedEntryCount: 1,
        Entries: [{}],
      });
    },
  };

  // Act
  const { response, loggerFake } = await runHeartbeatScenario(scenario);

  // Assert
  expect(response.status).toBe(HTTP_RESPONSE.INTERNAL_SERVER_ERROR);
  expect(response.text).toBe('Failed to publish heartbeat analytics event');
  const errorArgs = loggerFake.entries.errors[0] ?? [];
  const firstError = errorArgs[0];
  expect(firstError).toBeInstanceOf(Error);
  if (firstError instanceof Error) {
    expect(firstError.message).toContain('no details');
  }
};

const surfacesFailuresWithFallbackDetails = async (): Promise<void> => {
  // Arrange
  const scenario: HeartbeatScenarioOptions = {
    user: { sub: 'user-7', jti: 'token-7' },
    configureEventBridge: (fake) => {
      fake.queueSuccess({
        $metadata: { httpStatusCode: 200 },
        FailedEntryCount: 2,
        Entries: [
          {
            ErrorMessage: 'Partial failure',
          },
          {
            ErrorCode: 'Throttled',
          },
        ],
      });
    },
  };

  // Act
  const { response, loggerFake } = await runHeartbeatScenario(scenario);

  // Assert
  expect(response.status).toBe(HTTP_RESPONSE.INTERNAL_SERVER_ERROR);
  expect(response.text).toBe('Failed to publish heartbeat analytics event');
  const errorArgs = loggerFake.entries.errors[0] ?? [];
  const firstError = errorArgs[0];
  expect(firstError).toBeInstanceOf(Error);
  if (firstError instanceof Error) {
    expect(firstError.message).toContain(
      'Entry 0: UnknownError - Partial failure',
    );
    expect(firstError.message).toContain(
      'Entry 1: Throttled - Unknown failure',
    );
  }
};

const surfacesNonErrorPublishFailures = async (): Promise<void> => {
  // Arrange
  const scenario: HeartbeatScenarioOptions = {
    user: { sub: 'user-8', jti: 'token-8' },
    configureEventBridge: (fake) => {
      fake.queueFailure(new Error('catastrophic failure'));
    },
  };

  // Act
  const { response, loggerFake } = await runHeartbeatScenario(scenario);

  // Assert
  expect(response.status).toBe(HTTP_RESPONSE.INTERNAL_SERVER_ERROR);
  expect(response.text).toBe('Failed to publish heartbeat analytics event');
  const errorArgs = loggerFake.entries.errors[0] ?? [];
  const firstError = errorArgs[0];
  expect(firstError).toBeInstanceOf(Error);
  if (firstError instanceof Error) {
    expect(firstError.message).toBe('catastrophic failure');
  }
};

const obfuscatesMissingUserContext = async (): Promise<void> => {
  // Arrange
  const scenario: HeartbeatScenarioOptions = {
    configureEventBridge: (fake) => {
      fake.queueSuccess({
        $metadata: { httpStatusCode: 200 },
        FailedEntryCount: 0,
      });
    },
  };

  // Act
  const { response, eventBridgeFake, loggerFake } =
    await runHeartbeatScenario(scenario);

  // Assert
  expect(response.status).toBe(HTTP_RESPONSE.BAD_GATEWAY);
  expect(response.text).toBe('Bad Gateway');
  expect(eventBridgeFake.calls).toHaveLength(0);
  const errorArgs = loggerFake.entries.errors[0] ?? [];
  const firstError = errorArgs[0];
  expect(firstError).toBeInstanceOf(Error);
  if (firstError instanceof Error) {
    expect(firstError.message).toContain('missing user context');
  }
};

const initializeHeartbeatContext = (): void => {
  vi.resetModules();
  vi.stubEnv('APP_ENV', 'test-env');
  vi.stubEnv('APP_VERSION', '2.0.0');
  setBundledRuntime(false);
};

const cleanupHeartbeatContext = (): void => {
  vi.unstubAllEnvs();
  clearBundledRuntime();
};

const withEnvOverrides = async <T>(
  overrides: Record<string, string | undefined>,
  runScenario: () => Promise<T>,
): Promise<T> => {
  const previousEntries = Object.entries(overrides).map(
    ([key]): [string, string | undefined] => [key, process.env[key]],
  );
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return await runScenario();
  } finally {
    for (const [key, value] of previousEntries) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
};

const publishesHeartbeatEvent = async (): Promise<void> => {
  // Arrange
  const scenario: HeartbeatScenarioOptions = {
    user: { sub: 'user-1', jti: 'token-1' },
    platform: 'android',
    configureEventBridge: (fake) => {
      fake.queueSuccess({
        $metadata: { httpStatusCode: 200 },
        FailedEntryCount: 0,
      });
    },
  };

  // Act
  const { response, eventBridgeFake, loggerFake } =
    await runHeartbeatScenario(scenario);

  // Assert
  expect(response.status).toBe(HTTP_RESPONSE.OK);
  expect(response.text).toBe('OK');
  expect(eventBridgeFake.calls).toHaveLength(1);
  const [entry] = eventBridgeFake.calls[0]?.Entries ?? [];
  expect(entry?.EventBusName).toBe('analytics-bus');
  const parsedDetail: unknown = JSON.parse(entry?.Detail ?? '{}');
  if (!isRecord(parsedDetail)) {
    throw new Error('Heartbeat detail payload missing');
  }
  const detail = parsedDetail;
  expect(detail).toMatchObject({
    userId: 'user-1',
    env: 'test-env',
    appVersion: '2.0.0',
    platform: 'android',
  });
  expect(loggerFake.entries.logs).toContainEqual([
    'Heartbeat event recorded for user user-1',
  ]);
  expect(loggerFake.entries.errors).toHaveLength(0);
};

const usesNodeEnvAndPackageVersion = async (): Promise<void> => {
  // Arrange
  const scenario: HeartbeatScenarioOptions = {
    user: { sub: 'user-4', jti: 'token-4' },
    configureEventBridge: (fake) => {
      fake.queueSuccess({
        $metadata: { httpStatusCode: 200 },
        Entries: [],
      });
    },
  };

  // Act
  const { response, eventBridgeFake, loggerFake } = await withEnvOverrides(
    {
      APP_ENV: undefined,
      APP_VERSION: undefined,
      NODE_ENV: 'node-env',
      npm_package_version: '9.9.9',
    },
    () => runHeartbeatScenario(scenario),
  );

  // Assert
  expect(response.status).toBe(HTTP_RESPONSE.OK);
  expect(loggerFake.entries.errors).toHaveLength(0);
  const [entry] = eventBridgeFake.calls[0]?.Entries ?? [];
  const parsedDetail: unknown = JSON.parse(entry?.Detail ?? '{}');
  if (!isRecord(parsedDetail)) {
    throw new Error('Heartbeat detail payload missing');
  }
  expect(parsedDetail).toMatchObject({
    env: 'node-env',
    appVersion: '9.9.9',
  });
};

const fallsBackToUnknownEnvAndVersion = async (): Promise<void> => {
  // Arrange
  const scenario: HeartbeatScenarioOptions = {
    user: { sub: 'user-5', jti: 'token-5' },
    configureEventBridge: (fake) => {
      fake.queueSuccess({
        $metadata: { httpStatusCode: 200 },
        Entries: [],
      });
    },
  };

  // Act
  const { response, eventBridgeFake } = await withEnvOverrides(
    {
      APP_ENV: undefined,
      APP_VERSION: undefined,
      NODE_ENV: undefined,
      npm_package_version: undefined,
    },
    () => runHeartbeatScenario(scenario),
  );

  // Assert
  expect(response.status).toBe(HTTP_RESPONSE.OK);
  const [entry] = eventBridgeFake.calls[0]?.Entries ?? [];
  const parsedDetail: unknown = JSON.parse(entry?.Detail ?? '{}');
  if (!isRecord(parsedDetail)) {
    throw new Error('Heartbeat detail payload missing');
  }
  expect(parsedDetail).toMatchObject({
    env: 'unknown',
    appVersion: 'unknown',
  });
};

describe('heartbeatRequestHandler', () => {
  beforeEach(initializeHeartbeatContext);
  afterEach(cleanupHeartbeatContext);

  it('publishes a heartbeat event and returns 200', publishesHeartbeatEvent);
  it(
    'uses NODE_ENV and package version fallbacks when APP env vars are absent',
    usesNodeEnvAndPackageVersion,
  );
  it(
    'falls back to "unknown" env metadata when no env hints are available',
    fallsBackToUnknownEnvAndVersion,
  );
  it(
    'does not obfuscate when EventBridge reports failed entries',
    surfacesFailedEntriesWhenAuthenticated,
  );
  it(
    'does not obfuscate when publishing heartbeat event errors',
    surfacesPublishErrorsWhenAuthenticated,
  );
  it(
    'does not obfuscate when EventBridge reports failed entries with no detail',
    surfacesFailuresWithoutEntryDetails,
  );
  it(
    'does not obfuscate when EventBridge uses fallback code/message values',
    surfacesFailuresWithFallbackDetails,
  );
  it(
    'does not obfuscate when EventBridge rejects with a non-error cause',
    surfacesNonErrorPublishFailures,
  );
  it(
    'obfuscates requests that are missing authenticated user context',
    obfuscatesMissingUserContext,
  );
});
