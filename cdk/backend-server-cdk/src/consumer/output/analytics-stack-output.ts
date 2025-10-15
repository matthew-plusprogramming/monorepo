import { z } from 'zod';

import { ANALYTICS_STACK_NAME } from '../../stacks/names';

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
