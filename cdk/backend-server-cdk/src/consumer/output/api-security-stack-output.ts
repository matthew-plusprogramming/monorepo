import z from 'zod';

export const ApiSecurityStackOutputSchema = z.object({
  'api-security-stack': z.object({
    securityLogGroupName: z.string(),
    securityLogStreamName: z.string(),
    rateLimitTableName: z.string(),
    denyListTableName: z.string(),
  }),
});
