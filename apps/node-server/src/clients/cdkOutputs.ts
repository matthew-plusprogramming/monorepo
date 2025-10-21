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
export const usersTableName = apiOutput.userTableName;
export const rateLimitTableName = apiOutput.rateLimitTableName;
export const denyListTableName = apiOutput.denyListTableName;

const analyticsOutput = loadCDKOutput<typeof ANALYTICS_STACK_NAME>(
  ANALYTICS_STACK_NAME,
  baseCdkOutputsPath,
);

export const analyticsEventBusArn = analyticsOutput.eventBusArn;
export const analyticsEventBusName = analyticsOutput.eventBusName;
export const analyticsDeadLetterQueueArn = analyticsOutput.deadLetterQueueArn;
export const analyticsDeadLetterQueueUrl = analyticsOutput.deadLetterQueueUrl;
export const analyticsDedupeTableName = analyticsOutput.dedupeTableName;
export const analyticsAggregateTableName = analyticsOutput.aggregateTableName;
export const analyticsEventLogGroupName = analyticsOutput.eventLogGroupName;
export const analyticsProcessorLogGroupName =
  analyticsOutput.processorLogGroupName;
