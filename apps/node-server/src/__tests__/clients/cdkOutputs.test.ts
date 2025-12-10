import {
  ANALYTICS_LAMBDA_STACK_NAME,
  ANALYTICS_STACK_NAME,
  API_STACK_NAME,
} from '@cdk/platform-cdk';
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
  [ANALYTICS_STACK_NAME]: {
    analyticsEventBusArn: string;
    analyticsEventBusName: string;
    analyticsEventBusDeadLetterQueueArn: string;
    analyticsEventBusDeadLetterQueueUrl: string;
    analyticsDedupeTableName: string;
    analyticsEventDedupeTableName: string;
    analyticsMetricsAggregateTableName: string;
  };
  [ANALYTICS_LAMBDA_STACK_NAME]: {
    analyticsProcessorLambdaFunctionArn: string;
    analyticsProcessorLambdaFunctionName: string;
    analyticsProcessorRuleArn: string;
    analyticsProcessorRuleName: string;
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
      throw new Error(`Missing outputs for stack ${stack}`);
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
  const analyticsStackName = actual.ANALYTICS_STACK_NAME as StackName;
  const analyticsLambdaStackName =
    actual.ANALYTICS_LAMBDA_STACK_NAME as StackName;

  outputsByStack.set(apiStackName, {
    apiUserTableName: 'users-table',
    apiUserVerificationTableName: 'verification-table',
    apiRateLimitTableName: 'rate-limit-table',
    apiDenyListTableName: 'deny-list-table',
  });
  outputsByStack.set(analyticsStackName, {
    analyticsEventBusArn: 'analytics-bus-arn',
    analyticsEventBusName: 'analytics-bus',
    analyticsEventBusDeadLetterQueueArn: 'analytics-dlq-arn',
    analyticsEventBusDeadLetterQueueUrl: 'https://example.com/dlq',
    analyticsDedupeTableName: 'analytics-dedupe-table',
    analyticsEventDedupeTableName: 'analytics-dedupe-table',
    analyticsMetricsAggregateTableName: 'analytics-aggregate-table',
  });
  outputsByStack.set(analyticsLambdaStackName, {
    analyticsProcessorLambdaFunctionArn: 'analytics-processor-lambda-arn',
    analyticsProcessorLambdaFunctionName: 'analytics-processor-lambda',
    analyticsProcessorRuleArn: 'analytics-processor-rule-arn',
    analyticsProcessorRuleName: 'analytics-processor-rule',
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
