import { z } from 'zod';

export const ApiLambdaStackOutputSchema = z.object({
  apiLambdaFunctionUrl: z.url(),
});
