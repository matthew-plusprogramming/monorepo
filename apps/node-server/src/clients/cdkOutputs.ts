import { loadCDKOutput } from '@cdk/backend-server-cdk';

const baseCdkOutputsPath = __BUNDLED__ ? '.' : undefined;
const API_STACK = 'myapp-api-stack' as const;
const API_SECURITY_STACK = 'myapp-api-security-stack' as const;
const ANALYTICS_STACK = 'myapp-analytics-stack' as const;

const apiOutput = loadCDKOutput<typeof API_STACK>(
  API_STACK,
  baseCdkOutputsPath,
);
export const usersTableName = apiOutput.userTableName;

const securityOutput = loadCDKOutput<typeof API_SECURITY_STACK>(
  API_SECURITY_STACK,
  baseCdkOutputsPath,
);
export const rateLimitTableName = securityOutput.rateLimitTableName;
export const denyListTableName = securityOutput.denyListTableName;

const analyticsOutput = loadCDKOutput<typeof ANALYTICS_STACK>(
  ANALYTICS_STACK,
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
