import { z } from 'zod';

export const MyStackOutputSchema = z.object({
  'my-stack': z.object({
    userTableName: z.string(),
    verificationTableName: z.string(),
  }),
});
