import {
  ANALYTICS_LAMBDA_STACK_NAME,
  ANALYTICS_STACK_NAME,
  API_STACK_NAME,
} from '@cdk/backend-server-cdk';
import {
  clearBundledRuntime,
  setBundledRuntime,
} from '@packages/backend-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const outputsByStack = {
  [API_STACK_NAME]: {
    apiUserTableName: 'users-table',
    apiUserVerificationTableName: 'verification-table',
    apiRateLimitTableName: 'rate-limit-table',
    apiDenyListTableName: 'deny-list-table',
  },
  [ANALYTICS_STACK_NAME]: {
    analyticsEventBusArn: 'analytics-bus-arn',
    analyticsEventBusName: 'analytics-bus',
    analyticsEventBusDeadLetterQueueArn: 'analytics-dlq-arn',
    analyticsEventBusDeadLetterQueueUrl: 'https://example.com/dlq',
    analyticsDedupeTableName: 'analytics-dedupe-table',
    analyticsEventDedupeTableName: 'analytics-dedupe-table',
    analyticsMetricsAggregateTableName: 'analytics-aggregate-table',
  },
  [ANALYTICS_LAMBDA_STACK_NAME]: {
    analyticsProcessorLambdaFunctionArn: 'analytics-processor-lambda-arn',
    analyticsProcessorLambdaFunctionName: 'analytics-processor-lambda',
    analyticsProcessorRuleArn: 'analytics-processor-rule-arn',
    analyticsProcessorRuleName: 'analytics-processor-rule',
  },
} as const;

type StackName = keyof typeof outputsByStack;

type LoadCall = {
  readonly stack: StackName;
  readonly basePath: string | undefined;
};

const loadCalls: Array<LoadCall> = [];

// eslint-disable-next-line no-var
var loadCDKOutputMock: ReturnType<typeof vi.fn> | undefined;

type BackendServerCdkModule = Record<string, unknown> & {
  loadCDKOutput: (stack: string, basePath?: string) => unknown;
};

const isBackendServerCdkModule = (
  value: unknown,
): value is BackendServerCdkModule => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  if (!('loadCDKOutput' in value)) {
    return false;
  }
  const { loadCDKOutput } = value as { loadCDKOutput: unknown };
  return typeof loadCDKOutput === 'function';
};

vi.mock('@cdk/backend-server-cdk', async () => {
  const actual = await vi.importActual('@cdk/backend-server-cdk');
  if (!isBackendServerCdkModule(actual)) {
    throw new Error('Failed to load backend-server-cdk module');
  }

  loadCDKOutputMock = vi.fn((stack: StackName, basePath?: string) => {
    loadCalls.push({ stack, basePath });
    return outputsByStack[stack];
  });

  return {
    ...actual,
    loadCDKOutput: loadCDKOutputMock,
  };
});

// Disable for test file due to length
/* eslint-disable max-lines-per-function */
describe('clients/cdkOutputs', () => {
  beforeEach(() => {
    loadCalls.length = 0;
    loadCDKOutputMock?.mockClear();
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
    expect(loadCalls).toEqual([
      { stack: API_STACK_NAME, basePath: undefined },
      { stack: ANALYTICS_STACK_NAME, basePath: undefined },
      { stack: ANALYTICS_LAMBDA_STACK_NAME, basePath: undefined },
    ]);
    expect(module.usersTableName).toBe('users-table');
    expect(module.rateLimitTableName).toBe('rate-limit-table');
    expect(module.denyListTableName).toBe('deny-list-table');
    expect(module.analyticsEventBusArn).toBe('analytics-bus-arn');
    expect(module.analyticsEventBusName).toBe('analytics-bus');
    expect(module.analyticsDeadLetterQueueArn).toBe('analytics-dlq-arn');
    expect(module.analyticsDeadLetterQueueUrl).toBe('https://example.com/dlq');
    expect(module.analyticsDedupeTableName).toBe('analytics-dedupe-table');
    expect(module.analyticsAggregateTableName).toBe(
      'analytics-aggregate-table',
    );
    expect(module.analyticsProcessorLambdaFunctionArn).toBe(
      'analytics-processor-lambda-arn',
    );
    expect(module.analyticsProcessorLambdaFunctionName).toBe(
      'analytics-processor-lambda',
    );
    expect(module.analyticsProcessorRuleArn).toBe(
      'analytics-processor-rule-arn',
    );
    expect(module.analyticsProcessorRuleName).toBe('analytics-processor-rule');
  });

  it('uses bundled base path when __BUNDLED__ is true', async () => {
    // Arrange
    vi.resetModules();
    setBundledRuntime(true);

    // Act
    const module = await import('@/clients/cdkOutputs');

    // Assert
    expect(loadCalls).toEqual([
      { stack: API_STACK_NAME, basePath: '.' },
      { stack: ANALYTICS_STACK_NAME, basePath: '.' },
      { stack: ANALYTICS_LAMBDA_STACK_NAME, basePath: '.' },
    ]);
    expect(module.usersTableName).toBe('users-table');
    expect(module.rateLimitTableName).toBe('rate-limit-table');
    expect(module.denyListTableName).toBe('deny-list-table');
    expect(module.analyticsEventBusArn).toBe('analytics-bus-arn');
    expect(module.analyticsEventBusName).toBe('analytics-bus');
    expect(module.analyticsDeadLetterQueueArn).toBe('analytics-dlq-arn');
    expect(module.analyticsDeadLetterQueueUrl).toBe('https://example.com/dlq');
    expect(module.analyticsDedupeTableName).toBe('analytics-dedupe-table');
    expect(module.analyticsAggregateTableName).toBe(
      'analytics-aggregate-table',
    );
    expect(module.analyticsProcessorLambdaFunctionArn).toBe(
      'analytics-processor-lambda-arn',
    );
    expect(module.analyticsProcessorLambdaFunctionName).toBe(
      'analytics-processor-lambda',
    );
    expect(module.analyticsProcessorRuleArn).toBe(
      'analytics-processor-rule-arn',
    );
    expect(module.analyticsProcessorRuleName).toBe('analytics-processor-rule');
  });
});
/* eslint-enable max-lines-per-function */
