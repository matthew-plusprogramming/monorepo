import { z } from 'zod';

export const AnalyticsStackOutputSchema = z.object({
  'analytics-stack': z.object({
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
