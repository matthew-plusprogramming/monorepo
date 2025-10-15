import z from 'zod';

import { API_SECURITY_STACK_NAME } from '../../stacks/names';

export const ApiSecurityStackOutputSchema = z.object({
  [API_SECURITY_STACK_NAME]: z.object({
    rateLimitTableName: z.string(),
    denyListTableName: z.string(),
  }),
});
