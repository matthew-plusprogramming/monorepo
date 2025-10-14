import { z } from 'zod';

const API_STACK_NAME = 'myapp-api-stack' as const;

export const ApiStackOutputSchema = z.object({
  [API_STACK_NAME]: z.object({
    userTableName: z.string(),
    verificationTableName: z.string(),
  }),
});
