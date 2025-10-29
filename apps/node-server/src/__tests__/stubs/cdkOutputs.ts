const DEFAULT_CDK_OUTPUTS = {
  analyticsEventBusArn: 'analytics-bus-arn',
  analyticsEventBusName: 'analytics-bus',
  analyticsDeadLetterQueueArn: 'analytics-dlq-arn',
  analyticsDeadLetterQueueUrl: 'https://example.com/dlq',
  analyticsDedupeTableName: 'analytics-dedupe-table',
  analyticsAggregateTableName: 'analytics-aggregate-table',
  analyticsEventLogGroupName: 'analytics-event-log-group',
  analyticsProcessorLogGroupName: 'analytics-processor-log-group',
  analyticsProcessorLambdaFunctionArn: 'analytics-processor-lambda-arn',
  analyticsProcessorLambdaFunctionName: 'analytics-processor-lambda',
  analyticsProcessorRuleArn: 'analytics-processor-rule-arn',
  analyticsProcessorRuleName: 'analytics-processor-rule',
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
