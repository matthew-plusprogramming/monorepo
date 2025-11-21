import { z } from 'zod';

import {
  UserEmailSchema,
  UserIdSchema,
  UserNameSchema,
  UserPasswordHashSchema,
  UserUsernameSchema,
} from './components/index.js';

export const UserCreateSchema = z.object({
  id: UserIdSchema,
  name: UserNameSchema,
  username: UserUsernameSchema,
  email: UserEmailSchema,
  passwordHash: UserPasswordHashSchema,
});

export type UserCreate = z.infer<typeof UserCreateSchema>;
