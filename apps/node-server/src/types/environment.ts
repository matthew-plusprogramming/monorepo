import { z } from 'zod';

export const EnvironmentSchema = z.object({
  PORT: z.coerce.number().positive({ error: 'PORT must be a positive number' }),
  JWT_SECRET: z.string({ error: 'JWT_SECRET is required' }),
  AWS_ACCESS_KEY_ID: z.string({ error: 'AWS_ACCESS_KEY_ID is required' }),
  AWS_SECRET_ACCESS_KEY: z.string({
    error: 'AWS_SECRET_ACCESS_KEY is required',
  }),
  AWS_REGION: z.string({ error: 'AWS_REGION is required' }),
});

export type Environment = z.infer<typeof EnvironmentSchema>;
