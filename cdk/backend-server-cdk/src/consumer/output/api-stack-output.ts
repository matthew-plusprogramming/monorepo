import { z } from 'zod';

import { API_STACK_NAME } from '../../stacks/names';

export const ApiStackOutputSchema = z.object({
  [API_STACK_NAME]: z.object({
    userTableName: z.string(),
    verificationTableName: z.string(),
    rateLimitTableName: z.string(),
    denyListTableName: z.string(),
  }),
});
