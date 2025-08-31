import { z } from 'zod';
import { UserEmailSchema, UserIdSchema } from '../components';

export const GetUserSchema = z.union([UserIdSchema, UserEmailSchema]).meta({
  description: 'User identifier, can be either email or id',
});

export type GetUserInput = z.infer<typeof GetUserSchema>;
