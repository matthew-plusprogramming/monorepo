import { z } from 'zod';

export const EnvironmentSchema = z.object({
  AWS_ACCESS_KEY_ID: z.string({ error: 'AWS_ACCESS_KEY_ID is required' }),
  AWS_SECRET_ACCESS_KEY: z.string({
    error: 'AWS_SECRET_ACCESS_KEY is required',
  }),
  AWS_REGION: z.string({ error: 'AWS_REGION is required' }),
  PEPPER: z.string({ error: 'PEPPER is required' }),
  PORT: z.coerce.number().positive({ error: 'PORT must be a positive number' }),
  JWT_SECRET: z.string({ error: 'JWT_SECRET is required' }),
  APP_ENV: z.string().default('development'),
  APP_VERSION: z.string().default('0.0.0'),
  DEBUG: z.string().optional(),
  // Dashboard password authentication (AS-009)
  PASSWORD_HASH: z.string({ error: 'PASSWORD_HASH is required' }),
  SESSION_SECRET: z.string({ error: 'SESSION_SECRET is required' }),
  SESSION_EXPIRY_HOURS: z.coerce.number().positive().default(24),
  // Security settings
  ALLOWED_ORIGINS: z.string().optional(), // Comma-separated list of allowed origins
  WEBHOOK_SECRET: z.string({ error: 'WEBHOOK_SECRET is required for agent callbacks' }),
});

export type Environment = z.infer<typeof EnvironmentSchema>;
