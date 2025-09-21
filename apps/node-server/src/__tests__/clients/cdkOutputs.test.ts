import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const outputsByStack = {
  'api-stack': {
    userTableName: 'users-table',
    applicationLogGroupName: 'application-log-group',
    serverLogStreamName: 'server-log-stream',
  },
  'api-security-stack': {
    securityLogGroupName: 'security-log-group',
    securityLogStreamName: 'security-log-stream',
    rateLimitTableName: 'rate-limit-table',
    denyListTableName: 'deny-list-table',
  },
} as const;

type StackName = keyof typeof outputsByStack;

type LoadCall = {
  readonly stack: StackName;
  readonly basePath: string | undefined;
};

const loadCalls: Array<LoadCall> = [];

const loadCDKOutputMock = vi.fn((stack: StackName, basePath?: string) => {
  loadCalls.push({ stack, basePath });
  return outputsByStack[stack];
});

vi.mock('@cdk/backend-server-cdk', () => ({
  loadCDKOutput: loadCDKOutputMock,
}));

describe('clients/cdkOutputs', () => {
  beforeEach(() => {
    loadCalls.length = 0;
    loadCDKOutputMock.mockClear();
  });

  afterEach(() => {
    Reflect.deleteProperty(
      globalThis as typeof globalThis & { __BUNDLED__?: boolean },
      '__BUNDLED__',
    );
  });

  it('resolves outputs with default path when not bundled', async () => {
    vi.resetModules();
    (globalThis as typeof globalThis & { __BUNDLED__: boolean }).__BUNDLED__ =
      false;

    const module = await import('@/clients/cdkOutputs');

    expect(loadCalls.map((call) => call.stack)).toEqual([
      'api-stack',
      'api-stack',
      'api-stack',
      'api-security-stack',
      'api-security-stack',
      'api-security-stack',
      'api-security-stack',
    ]);
    expect(loadCalls.every((call) => call.basePath === undefined)).toBe(true);

    expect(module.usersTableName).toBe('users-table');
    expect(module.applicationLogGroupName).toBe('application-log-group');
    expect(module.serverLogStreamName).toBe('server-log-stream');
    expect(module.securityLogGroupName).toBe('security-log-group');
    expect(module.securityLogStreamName).toBe('security-log-stream');
    expect(module.rateLimitTableName).toBe('rate-limit-table');
    expect(module.denyListTableName).toBe('deny-list-table');
  });

  it('uses bundled base path when __BUNDLED__ is true', async () => {
    vi.resetModules();
    (globalThis as typeof globalThis & { __BUNDLED__: boolean }).__BUNDLED__ =
      true;

    const module = await import('@/clients/cdkOutputs');

    expect(loadCalls).toHaveLength(7);
    expect(loadCalls.every((call) => call.basePath === '.')).toBe(true);

    expect(module.usersTableName).toBe('users-table');
    expect(module.applicationLogGroupName).toBe('application-log-group');
    expect(module.serverLogStreamName).toBe('server-log-stream');
    expect(module.securityLogGroupName).toBe('security-log-group');
    expect(module.securityLogStreamName).toBe('security-log-stream');
    expect(module.rateLimitTableName).toBe('rate-limit-table');
    expect(module.denyListTableName).toBe('deny-list-table');
  });
});
