import { z } from 'zod';

import { UserPlaintextPasswordSchema } from '../components/index.js';

import { GetUserSchema } from './getUser.js';

export const LoginInputSchema = z.object({
  identifier: GetUserSchema,
  password: UserPlaintextPasswordSchema,
});

export type LoginInput = z.infer<typeof LoginInputSchema>;
