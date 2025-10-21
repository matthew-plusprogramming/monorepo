import { ANALYTICS_STACK_NAME, API_STACK_NAME } from '@cdk/backend-server-cdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const outputsByStack = {
  [API_STACK_NAME]: {
    userTableName: 'users-table',
    verificationTableName: 'verification-table',
    rateLimitTableName: 'rate-limit-table',
    denyListTableName: 'deny-list-table',
  },
  [ANALYTICS_STACK_NAME]: {
    eventBusArn: 'analytics-bus-arn',
    eventBusName: 'analytics-bus',
    deadLetterQueueArn: 'analytics-dlq-arn',
    deadLetterQueueUrl: 'https://example.com/dlq',
    dedupeTableName: 'analytics-dedupe-table',
    aggregateTableName: 'analytics-aggregate-table',
    eventLogGroupName: 'analytics-event-log-group',
    processorLogGroupName: 'analytics-processor-log-group',
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

function isBackendServerCdkModule(
  value: unknown,
): value is BackendServerCdkModule {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  if (!('loadCDKOutput' in value)) {
    return false;
  }
  const { loadCDKOutput } = value as { loadCDKOutput: unknown };
  return typeof loadCDKOutput === 'function';
}

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

describe('clients/cdkOutputs', () => {
  beforeEach(() => {
    loadCalls.length = 0;
    loadCDKOutputMock?.mockClear();
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, '__BUNDLED__');
  });

  it('resolves outputs with default path when not bundled', async () => {
    vi.resetModules();
    Reflect.set(globalThis, '__BUNDLED__', false);

    const module = await import('@/clients/cdkOutputs');

    expect(loadCalls).toEqual([
      { stack: API_STACK_NAME, basePath: undefined },
      { stack: ANALYTICS_STACK_NAME, basePath: undefined },
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
    expect(module.analyticsEventLogGroupName).toBe('analytics-event-log-group');
    expect(module.analyticsProcessorLogGroupName).toBe(
      'analytics-processor-log-group',
    );
  });

  it('uses bundled base path when __BUNDLED__ is true', async () => {
    vi.resetModules();
    Reflect.set(globalThis, '__BUNDLED__', true);

    const module = await import('@/clients/cdkOutputs');

    expect(loadCalls).toEqual([
      { stack: API_STACK_NAME, basePath: '.' },
      { stack: ANALYTICS_STACK_NAME, basePath: '.' },
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
    expect(module.analyticsEventLogGroupName).toBe('analytics-event-log-group');
    expect(module.analyticsProcessorLogGroupName).toBe(
      'analytics-processor-log-group',
    );
  });
});
