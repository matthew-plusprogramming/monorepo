import { z } from 'zod';
import {
  UserEmailSchema,
  UserPlaintextPasswordSchema,
  UserUsernameSchema,
} from './user';

export const RegisterInputSchema = z.object({
  username: UserUsernameSchema,
  email: UserEmailSchema,
  password: UserPlaintextPasswordSchema,
});

export type RegisterInput = z.infer<typeof RegisterInputSchema>;
