import { z } from 'zod';

const ANALYTICS_STACK_NAME = 'myapp-analytics-stack' as const;

export const AnalyticsStackOutputSchema = z.object({
  [ANALYTICS_STACK_NAME]: z.object({
    eventBusArn: z.string(),
    eventBusName: z.string(),
    deadLetterQueueArn: z.string(),
    deadLetterQueueUrl: z.string(),
    dedupeTableName: z.string(),
    aggregateTableName: z.string(),
    eventLogGroupName: z.string(),
    processorLogGroupName: z.string(),
  }),
});
