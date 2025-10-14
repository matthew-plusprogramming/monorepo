import z from 'zod';

const API_SECURITY_STACK_NAME = 'myapp-api-security-stack' as const;

export const ApiSecurityStackOutputSchema = z.object({
  [API_SECURITY_STACK_NAME]: z.object({
    rateLimitTableName: z.string(),
    denyListTableName: z.string(),
  }),
});
