import {
  ANALYTICS_STACK_NAME,
  API_STACK_NAME,
  loadCDKOutput,
} from '@cdk/backend-server-cdk';

const baseCdkOutputsPath = __BUNDLED__ ? '.' : undefined;

const apiOutput = loadCDKOutput<typeof API_STACK_NAME>(
  API_STACK_NAME,
  baseCdkOutputsPath,
);
export const usersTableName = apiOutput.apiUserTableName;
export const rateLimitTableName = apiOutput.apiRateLimitTableName;
export const denyListTableName = apiOutput.apiDenyListTableName;

const analyticsOutput = loadCDKOutput<typeof ANALYTICS_STACK_NAME>(
  ANALYTICS_STACK_NAME,
  baseCdkOutputsPath,
);

export const analyticsEventBusArn = analyticsOutput.analyticsEventBusArn;
export const analyticsEventBusName = analyticsOutput.analyticsEventBusName;
export const analyticsDeadLetterQueueArn =
  analyticsOutput.analyticsEventBusDeadLetterQueueArn;
export const analyticsDeadLetterQueueUrl =
  analyticsOutput.analyticsEventBusDeadLetterQueueUrl;
export const analyticsDedupeTableName =
  analyticsOutput.analyticsEventDedupeTableName;
export const analyticsAggregateTableName =
  analyticsOutput.analyticsMetricsAggregateTableName;
export const analyticsEventLogGroupName =
  analyticsOutput.analyticsEventIngestionLogGroupName;
export const analyticsProcessorLogGroupName =
  analyticsOutput.analyticsProcessorLogGroupName;
