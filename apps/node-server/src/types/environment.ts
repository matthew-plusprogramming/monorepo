import { z } from 'zod';

export const EnvironmentSchema = z.object({
  PORT: z.coerce.number().positive({ error: 'PORT must be a positive number' }),
  JWT_SECRET: z.string({ error: 'JWT_SECRET is required' }),
});

export type Environment = z.infer<typeof EnvironmentSchema>;
