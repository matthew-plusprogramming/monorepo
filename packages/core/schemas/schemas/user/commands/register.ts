import { z } from 'zod';

import {
  UserEmailSchema,
  UserNameSchema,
  UserPlaintextPasswordSchema,
  UserUsernameSchema,
} from '../components/index.js';

export const RegisterInputSchema = z.object({
  name: UserNameSchema,
  username: UserUsernameSchema,
  email: UserEmailSchema,
  password: UserPlaintextPasswordSchema,
});

export type RegisterInput = z.infer<typeof RegisterInputSchema>;
