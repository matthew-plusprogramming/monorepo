import { loadCDKOutput } from '@cdk/backend-server-cdk';

const baseCdkOutputsPath = __BUNDLED__ ? '.' : undefined;

export const usersTableName = loadCDKOutput<'api-stack'>(
  'api-stack',
  baseCdkOutputsPath,
).userTableName;

export const applicationLogGroupName = loadCDKOutput<'api-stack'>(
  'api-stack',
  baseCdkOutputsPath,
).applicationLogGroupName;
export const serverLogStreamName = loadCDKOutput<'api-stack'>(
  'api-stack',
  baseCdkOutputsPath,
).serverLogStreamName;

export const securityLogGroupName = loadCDKOutput<'api-security-stack'>(
  'api-security-stack',
  baseCdkOutputsPath,
).securityLogGroupName;
export const securityLogStreamName = loadCDKOutput<'api-security-stack'>(
  'api-security-stack',
  baseCdkOutputsPath,
).securityLogStreamName;
export const rateLimitTableName = loadCDKOutput<'api-security-stack'>(
  'api-security-stack',
  baseCdkOutputsPath,
).rateLimitTableName;
export const denyListTableName = loadCDKOutput<'api-security-stack'>(
  'api-security-stack',
  baseCdkOutputsPath,
).denyListTableName;

const analyticsOutput = loadCDKOutput<'analytics-stack'>(
  'analytics-stack',
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
