import { z } from 'zod';

import { API_STACK_NAME } from '../../stacks/names';

export const ApiStackOutputSchema = z.object({
  [API_STACK_NAME]: z.object({
    apiUserTableName: z.string(),
    apiUserVerificationTableName: z.string(),
    apiRateLimitTableName: z.string(),
    apiDenyListTableName: z.string(),
  }),
});
