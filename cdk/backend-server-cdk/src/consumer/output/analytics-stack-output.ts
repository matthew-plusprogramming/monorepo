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
    analyticsProcessorLambdaFunctionArn: z.string(),
    analyticsProcessorLambdaFunctionName: z.string(),
    analyticsProcessorRuleArn: z.string(),
    analyticsProcessorRuleName: z.string(),
  }),
});
