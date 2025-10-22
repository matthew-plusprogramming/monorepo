const DEFAULT_CDK_OUTPUTS = {
  analyticsEventBusArn: 'analytics-bus-arn',
  analyticsEventBusName: 'analytics-bus',
  analyticsDeadLetterQueueArn: 'analytics-dlq-arn',
  analyticsDeadLetterQueueUrl: 'https://example.com/dlq',
  analyticsDedupeTableName: 'analytics-dedupe-table',
  analyticsAggregateTableName: 'analytics-aggregate-table',
  analyticsEventLogGroupName: 'analytics-event-log-group',
  analyticsProcessorLogGroupName: 'analytics-processor-log-group',
  rateLimitTableName: 'rate-limit-table',
  denyListTableName: 'deny-list-table',
  usersTableName: 'users-table',
};

export type CdkOutputsStub = typeof DEFAULT_CDK_OUTPUTS;

export const makeCdkOutputsStub = (
  overrides: Partial<CdkOutputsStub> = {},
): CdkOutputsStub => ({
  ...DEFAULT_CDK_OUTPUTS,
  ...overrides,
});
