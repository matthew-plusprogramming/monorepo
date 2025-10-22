import { z } from 'zod';

import { ANALYTICS_STACK_NAME } from '../../stacks/names';

export const AnalyticsStackOutputSchema = z.object({
  [ANALYTICS_STACK_NAME]: z.object({
    analyticsEventBusArn: z.string(),
    analyticsEventBusName: z.string(),
    analyticsEventBusDeadLetterQueueArn: z.string(),
    analyticsEventBusDeadLetterQueueUrl: z.string(),
    analyticsEventDedupeTableName: z.string(),
    analyticsMetricsAggregateTableName: z.string(),
    analyticsEventIngestionLogGroupName: z.string(),
    analyticsProcessorLogGroupName: z.string(),
  }),
});
