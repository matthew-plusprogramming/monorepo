import { z } from 'zod';
import {
  UserEmailSchema,
  UserPlaintextPasswordSchema,
  UserUsernameSchema,
} from '../components';

export const RegisterInputSchema = z.object({
  username: UserUsernameSchema,
  email: UserEmailSchema,
  password: UserPlaintextPasswordSchema,
});

export type RegisterInput = z.infer<typeof RegisterInputSchema>;
