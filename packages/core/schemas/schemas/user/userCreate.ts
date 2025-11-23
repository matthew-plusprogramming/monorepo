import { z } from 'zod';

import {
  UserEmailSchema,
  UserFullNameSchema,
  UserIdSchema,
  UserPasswordHashSchema,
  UserUsernameSchema,
} from './components/index.js';

export const UserCreateSchema = z.object({
  id: UserIdSchema,
  fullName: UserFullNameSchema,
  username: UserUsernameSchema,
  email: UserEmailSchema,
  passwordHash: UserPasswordHashSchema,
});

export type UserCreate = z.infer<typeof UserCreateSchema>;
