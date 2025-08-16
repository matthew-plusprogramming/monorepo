import { z } from 'zod';

export const ApiStackOutputSchema = z.object({
  'api-stack': z.object({
    userTableName: z.string(),
    verificationTableName: z.string(),
    applicationLogGroupName: z.string(),
    serverLogStreamName: z.string(),
  }),
});
