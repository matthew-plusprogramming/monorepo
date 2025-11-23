import { z } from 'zod';

import {
  UserEmailSchema,
  UserFullNameSchema,
  UserPlaintextPasswordSchema,
  UserUsernameSchema,
} from '../components/index.js';

export const RegisterInputSchema = z.object({
  fullName: UserFullNameSchema,
  username: UserUsernameSchema,
  email: UserEmailSchema,
  password: UserPlaintextPasswordSchema,
});

export type RegisterInput = z.infer<typeof RegisterInputSchema>;
