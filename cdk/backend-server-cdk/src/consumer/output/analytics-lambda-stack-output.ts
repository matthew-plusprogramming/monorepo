import { z } from 'zod';

import { ANALYTICS_LAMBDA_STACK_NAME } from '../../stacks/names';

export const AnalyticsLambdaStackOutputSchema = z.object({
  [ANALYTICS_LAMBDA_STACK_NAME]: z.object({
    analyticsProcessorLambdaFunctionArn: z.string(),
    analyticsProcessorLambdaFunctionName: z.string(),
    analyticsProcessorRuleArn: z.string(),
    analyticsProcessorRuleName: z.string(),
  }),
});
